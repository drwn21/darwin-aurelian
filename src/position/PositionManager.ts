import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Position, CloseReason, TradeRecord, GmgnSnapshot } from '../types/index.js';
import { STRATEGY } from '../config/config.js';
import { configManager } from '../config/ConfigManager.js';
import { POSITION_CHECK_INTERVAL_MS, PRICE_UPDATE_INTERVAL_MS, TRAILING_CHECK_INTERVAL_MS, MAX_PRICE_RATIO, MAX_CONSECUTIVE_SPIKE_REJECTS } from '../config/constants.js';
import { JupiterClient } from '../execution/JupiterClient.js';
import { GmgnClient } from '../discovery/GmgnClient.js';
import { ExecutionEngine } from '../execution/ExecutionEngine.js';
import { TradeHistory } from '../logger/TradeHistory.js';
import { logger } from '../logger/Logger.js';
import { getTokenBalance } from '../utils/solana.js';
import { checkBundlerPattern, saveBundlerDetection } from '../screening/BundlerDetector.js';
import { RugSignalDetector } from '../screening/RugSignalDetector.js';

/** Minimum gap between runtime bundler / rug-signal checks for a position. */
const SAFETY_CHECK_INTERVAL_MS = 30_000;

/** Where open positions are persisted for crash recovery. */
const DATA_DIR = path.join(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');

/** Grace period after open — don't force-close on price-feed misses within this window. */
const PRICE_FAIL_GRACE_MS = 120_000; // 2 minutes

type CloseHandler = (position: Position) => void;

/**
 * Tiered trailing stop: tighten trail % as unrealized profit grows.
 * Locks in more gains on big runners while giving fresh positions room to breathe.
 * All thresholds are configurable via the Telegram "Trailing" panel.
 */
function computeTieredTrailDrop(
  unrealisedPnlPct: number,
  baseTrail: number,
  cfg?: { tieredTrailingEnabled?: boolean; tieredTrailAt100Pct?: number; tieredTrailAt200Pct?: number; tieredTrailAt500Pct?: number; tieredTrailAt1000Pct?: number },
): number {
  if (!cfg?.tieredTrailingEnabled) return baseTrail;
  const t100 = cfg.tieredTrailAt100Pct ?? 16;
  const t200 = cfg.tieredTrailAt200Pct ?? 13;
  const t500 = cfg.tieredTrailAt500Pct ?? 10;
  const t1000 = cfg.tieredTrailAt1000Pct ?? 8;
  if (unrealisedPnlPct >= 1000) return Math.min(baseTrail, t1000);
  if (unrealisedPnlPct >= 500)  return Math.min(baseTrail, t500);
  if (unrealisedPnlPct >= 200)  return Math.min(baseTrail, t200);
  if (unrealisedPnlPct >= 100)  return Math.min(baseTrail, t100);
  return baseTrail;
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private jupiter: JupiterClient;
  private gmgn: GmgnClient;
  private engine: ExecutionEngine;
  private history: TradeHistory;
  private rugDetector: RugSignalDetector;
  private onClose?: CloseHandler;
  private onPartialClose?: (pnlSol: number) => void;
  private onAlert?: (msg: string) => void;
  private priceTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private trailingTimer: NodeJS.Timeout | null = null;
  private liquidityTimer: NodeJS.Timeout | null = null;
  private forceProbeTick = 0;

  constructor(
    engine?: ExecutionEngine,
    history?: TradeHistory,
  ) {
    this.jupiter = new JupiterClient();
    this.gmgn = new GmgnClient();
    this.engine = engine ?? new ExecutionEngine();
    this.history = history ?? new TradeHistory();
    this.rugDetector = new RugSignalDetector();
    this.loadPositions();
  }

  getHistory(): TradeHistory {
    return this.history;
  }

  onPositionClosed(handler: CloseHandler): void {
    this.onClose = handler;
  }

  /**
   * Register a handler invoked after a partial sell that leaves the position
   * open (e.g. the TP partial). Lets the risk manager record the realized PnL of
   * the sold slice — the full-close path only reports the remaining slice.
   */
  onPartialSell(handler: (pnlSol: number) => void): void {
    this.onPartialClose = handler;
  }

  onAlertHandler(handler: (msg: string) => void): void {
    this.onAlert = handler;
  }

  /**
   * Restore open positions from disk so a restart/crash doesn't orphan live
   * positions (which would leave TP/SL unmanaged). Transient flags are reset:
   * `selling` is cleared (a sell can't survive a process restart) and a
   * `pending_sell` status is reverted to `open` so the next cycle retries.
   */
  private loadPositions(): void {
    try {
      if (!fs.existsSync(POSITIONS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8')) as Position[];
      for (const p of raw) {
        if (p.status === 'closed') continue; // closed positions aren't managed
        p.selling = false;
        if (p.status === 'pending_sell') p.status = 'open';
        this.positions.set(p.tokenAddress, p);
      }
      logger.info('Positions restored from disk', { count: this.positions.size });
    } catch (err) {
      logger.warn('Failed to load positions from disk', { err: String(err) });
    }
  }

  /** Persist the current position map to disk after every state change. */
  private savePositions(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify([...this.positions.values()], null, 2));
    } catch (err) {
      logger.error('Failed to persist positions', { err: String(err) });
    }
  }

  start(): void {
    this.priceTimer = setInterval(() => void this.updatePrices(), PRICE_UPDATE_INTERVAL_MS);
    this.checkTimer = setInterval(() => void this.checkTPSL(), POSITION_CHECK_INTERVAL_MS);
    // Fast-path trailing: 2s interval for positions with firstTargetHit=true
    this.trailingTimer = setInterval(() => void this.trailingTick(), TRAILING_CHECK_INTERVAL_MS);
    // Liquidity monitoring: check every 60s (less frequent than price updates)
    this.liquidityTimer = setInterval(() => void this.checkLiquidity(), 60_000);
    logger.info('PositionManager started');
  }

  stop(): void {
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.trailingTimer) clearInterval(this.trailingTimer);
    if (this.liquidityTimer) clearInterval(this.liquidityTimer);
    logger.info('PositionManager stopped');
  }

  async openPosition(
    tokenAddress: string,
    tokenSymbol: string,
    entryPrice: number,
    entryAmountSol: number,
    tokensReceived: number,
    txSig: string,
    decimals?: number,
    marketCapUsd?: number,
    entryLiquidityUsd?: number,
    themeKey?: string,
    entrySmartDegenCount?: number,
    gmgnSnapshot?: GmgnSnapshot,
  ): Promise<Position> {
    const buyPriorityFeeSol = configManager.get().strategy.priorityFeeLamports / 1_000_000_000;
    const pos: Position = {
      id: randomUUID(),
      tokenAddress,
      tokenSymbol,
      entryPrice,
      currentPrice: entryPrice,
      peakPrice: entryPrice,
      firstTargetHit: false,
      slBelowCount: 0,
      entryAmountSol,
      tokensReceived,
      decimals,
      marketCapUsd,
      entryLiquidityUsd,
      entryTxSig: txSig,
      openedAt: Date.now(),
      status: 'open',
      sellRetryCount: 0,
      transientRetryCount: 0,
      takeProfitPct: configManager.get().strategy.takeProfitPct ?? STRATEGY.takeProfitPct,
      stopLossPct: configManager.get().strategy.stopLossPct ?? STRATEGY.stopLossPct,
      themeKey,
      buyPriorityFeeSol,
      entrySmartDegenCount,
      gmgnSnapshot,
    };
    this.positions.set(tokenAddress, pos);
    this.savePositions();

    const trade: TradeRecord = {
      positionId: pos.id,
      tokenAddress,
      tokenSymbol,
      side: 'buy',
      amountSol: entryAmountSol,
      price: entryPrice,
      txSig,
      timestamp: pos.openedAt,
      priorityFee: buyPriorityFeeSol,
    };
    this.history.record(trade);

    logger.info('Position opened', {
      symbol: tokenSymbol,
      entryPrice,
      solIn: entryAmountSol,
      buyPriorityFeeSol,
    });
    return pos;
  }

  async closePosition(tokenAddress: string, reason: CloseReason): Promise<void> {
    const pos = this.positions.get(tokenAddress);
    if (!pos || pos.status !== 'open') return;

    // Capture sell priority fee cost for PnL calculation
    const sellPriorityFeeSol = configManager.get().strategy.priorityFeeLamports / 1_000_000_000;
    // H3: serialize sells per position — a second TP/SL check (or a manual
    // trigger) must not fire a duplicate sell while one is already in flight.
    if (pos.selling) {
      logger.debug('closePosition skipped — sell already in flight', { token: tokenAddress });
      return;
    }
    pos.selling = true;
    try {
      await this.performClose(pos, tokenAddress, reason, sellPriorityFeeSol);
    } finally {
      pos.selling = false;
    }
  }

  private async performClose(pos: Position, tokenAddress: string, reason: CloseReason, sellPriorityFeeSol: number): Promise<void> {
    pos.status = 'pending_sell';

    const result = await this.engine.sell(tokenAddress, pos.tokensReceived);
    if (!result.success) {
      // Fallback: retry with actual on-chain balance (may differ due to
      // slippage, partial-sell timeout desync, or dust rounding).
      let onChainBalance = 0;
      try {
        onChainBalance = await getTokenBalance(tokenAddress);
      } catch { /* ignore */ }

      if (onChainBalance > 0 && onChainBalance !== pos.tokensReceived) {
        logger.warn('Sell failed — retrying with on-chain balance', {
          token: tokenAddress,
          tracked: pos.tokensReceived,
          onChain: onChainBalance,
        });
        const retry = await this.engine.sell(tokenAddress, onChainBalance);
        if (retry.success) {
          // Treat retry success as a normal close
          const solReceived = Math.abs(retry.solSpent ?? 0);
          const buyPf = pos.buyPriorityFeeSol ?? 0;
          const reclaimedSol = retry.reclaimedSol ?? 0;
          const pnlSol = solReceived + reclaimedSol - pos.entryAmountSol - buyPf - sellPriorityFeeSol;
          const pnlPct = (pnlSol / pos.entryAmountSol) * 100;

          pos.status = 'closed';
          pos.closedAt = Date.now();
          pos.exitTxSig = retry.txSig;
          pos.exitAmountSol = solReceived;
          pos.realisedPnlSol = pnlSol;
          pos.closeReason = reason;
          pos.tokensReceived = 0;

          const trade: TradeRecord = {
            positionId: pos.id,
            tokenAddress,
            tokenSymbol: pos.tokenSymbol,
            side: 'sell',
            amountSol: solReceived,
            price: pos.currentPrice,
            txSig: retry.txSig ?? '',
            timestamp: Date.now(),
            pnlSol,
            pnlPct,
            closeReason: reason,
            priorityFee: sellPriorityFeeSol,
          };
          this.history.record(trade);

          logger.info('Position closed (retry with on-chain balance)', {
            symbol: pos.tokenSymbol,
            reason,
            pnlSol: pnlSol.toFixed(4),
            pnlPct: pnlPct.toFixed(1) + '%',
          });

          this.positions.delete(tokenAddress);
          this.savePositions();
          this.onClose?.(pos);
          return;
        }
      }

      // If on-chain balance is 0, the sell actually succeeded on-chain
      // (e.g. confirmation timed out but tx landed). Mark as closed.
      if (onChainBalance === 0) {
        logger.warn('Sell reported failure but on-chain balance is 0 — marking closed', {
          token: tokenAddress,
          symbol: pos.tokenSymbol,
          reason,
        });
        pos.status = 'closed';
        pos.closedAt = Date.now();
        pos.tokensReceived = 0;
        pos.closeReason = reason;
        this.positions.delete(tokenAddress);
        this.savePositions();
        this.onClose?.(pos);
        return;
      }

      // H1: distinguish a real honeypot (permanent — no route / sim failed) from
      // a transient Jupiter/RPC blip (429 / timeout / network). Only permanent
      // failures count toward the retry limit that records a -100% honeypot loss.
      // Transient failures just retry next cycle so a flaky API can't mark a
      // sellable position as unsellable.
      const failureType = result.failureType ?? 'permanent';
      if (failureType === 'transient') {
        // Transient failures never force-close (a flaky API mustn't mark a
        // sellable position unsellable), but they shouldn't retry silently
        // forever either. Count them and alert the operator once the count
        // crosses the configured limit — without auto-selling or marking as a
        // honeypot. The position stays open and keeps retrying.
        pos.transientRetryCount = (pos.transientRetryCount ?? 0) + 1;
        const maxTransientSellRetries = configManager.get().strategy.maxTransientSellRetries;
        logger.warn('Sell failed (transient) — retrying next cycle, not counting toward honeypot limit', {
          token: tokenAddress,
          symbol: pos.tokenSymbol,
          reason,
          transientRetries: pos.transientRetryCount,
          error: result.error,
        });
        if (pos.transientRetryCount >= maxTransientSellRetries && !pos.transientRetryAlerted) {
          pos.transientRetryAlerted = true;
          logger.error('Transient sell retry limit reached — alerting operator (still retrying)', {
            token: tokenAddress,
            symbol: pos.tokenSymbol,
            transientRetries: pos.transientRetryCount,
          });
          this.onAlert?.(
            `⚠️ Position ${pos.tokenSymbol} has failed to sell ${pos.transientRetryCount} times ` +
            `(transient errors). Manual intervention may be needed.`,
          );
        }
        pos.status = 'open'; // revert so we retry next cycle
        this.savePositions();
        return;
      }

      // Permanent failure path — increment retry counter
      pos.sellRetryCount = (pos.sellRetryCount ?? 0) + 1;

      const maxSellRetries = configManager.get().strategy.maxSellRetries;
      if (pos.sellRetryCount >= maxSellRetries) {
        logger.error('Sell retry limit reached — recording -100% loss and closing', {
          token: tokenAddress,
          symbol: pos.tokenSymbol,
          reason,
          retries: pos.sellRetryCount,
          error: result.error,
        });

        // Record -100% PnL — token is unsellable (honeypot / dead LP)
        const buyPf = pos.buyPriorityFeeSol ?? 0;
        const pnlSol = -pos.entryAmountSol - buyPf;
        const pnlPct = -100;

        pos.status = 'closed';
        pos.closedAt = Date.now();
        pos.exitAmountSol = 0;
        pos.realisedPnlSol = pnlSol;
        pos.closeReason = 'sell_stuck';
        pos.tokensReceived = 0;

        const trade: TradeRecord = {
          positionId: pos.id,
          tokenAddress,
          tokenSymbol: pos.tokenSymbol,
          side: 'sell',
          amountSol: 0,
          price: 0,
          txSig: '',
          timestamp: Date.now(),
          pnlSol,
          pnlPct,
          closeReason: 'sell_stuck',
        };
        this.history.record(trade);

        logger.info('Position closed as honeypot loss', {
          symbol: pos.tokenSymbol,
          pnlSol: pnlSol.toFixed(4),
          pnlPct: '-100%',
        });

        this.positions.delete(tokenAddress);
        this.savePositions();
        this.onClose?.(pos);
        return;
      }

      const posAgeMs = Date.now() - pos.openedAt;
      const canSellBackMinAgeMs = configManager.get().strategy.canSellBackMinAgeMs;
      const isEmergency = reason === 'stop_loss' || reason === 'hard_stop_loss' ||
        reason === 'price_feed_dark' || reason === 'liquidity_drop' || reason === 'rug_signal';
      if (posAgeMs < canSellBackMinAgeMs && !isEmergency) {
        logger.warn('Sell failed on young position — will retry next cycle', {
          token: tokenAddress,
          symbol: pos.tokenSymbol,
          reason,
          posAgeMs: Math.round(posAgeMs),
          canSellBackMinAgeMs,
          error: result.error,
        });
      } else {
        logger.error('Failed to close position', { token: tokenAddress, reason, error: result.error });
      }
      pos.status = 'open'; // revert so we retry next cycle
      this.savePositions();
      return;
    }

    const solReceived = Math.abs(result.solSpent ?? 0);
    const buyPf = pos.buyPriorityFeeSol ?? 0;
    const reclaimedSol = result.reclaimedSol ?? 0;
    const pnlSol = solReceived + reclaimedSol - pos.entryAmountSol - buyPf - sellPriorityFeeSol;
    const pnlPct = (pnlSol / pos.entryAmountSol) * 100;

    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.exitTxSig = result.txSig;
    pos.exitAmountSol = solReceived;
    pos.realisedPnlSol = pnlSol;
    pos.closeReason = reason;

    const trade: TradeRecord = {
      positionId: pos.id,
      tokenAddress,
      tokenSymbol: pos.tokenSymbol,
      side: 'sell',
      amountSol: solReceived,
      price: pos.currentPrice,
      txSig: result.txSig ?? '',
      timestamp: Date.now(),
      pnlSol,
      pnlPct,
      closeReason: reason,
      priorityFee: sellPriorityFeeSol,
    };
    this.history.record(trade);

    const logFields: Record<string, unknown> = {
      symbol: pos.tokenSymbol,
      reason,
      pnlSol: pnlSol.toFixed(4),
      pnlPct: pnlPct.toFixed(1) + '%',
    };
    if (reclaimedSol > 0) {
      logFields.reclaimedSol = reclaimedSol.toFixed(4);
    }
    logger.info('Position closed', logFields);

    this.positions.delete(tokenAddress);
    this.savePositions();
    this.onClose?.(pos);
  }

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === 'open');
  }

  getOpenCount(): number {
    return this.getOpenPositions().length;
  }

  hasPosition(tokenAddress: string): boolean {
    return this.positions.has(tokenAddress);
  }

  getPosition(tokenAddress: string): Position | undefined {
    return this.positions.get(tokenAddress);
  }

  formatPositionsSummary(): string {
    const open = this.getOpenPositions();
    if (open.length === 0) return 'No open positions.';
    return open
      .map((p) => {
        const pnl = (((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(1);
        const sign = parseFloat(pnl) >= 0 ? '+' : '';
        return `${p.tokenSymbol}: ${sign}${pnl}% | in ${p.entryAmountSol.toFixed(3)} SOL`;
      })
      .join('\n');
  }

  /** Public wrapper so the UI can trigger an on-demand price refresh. */
  async updatePricesNow(): Promise<void> {
    return this.updatePrices();
  }

  private async updatePrices(): Promise<void> {
    const open = this.getOpenPositions();
    if (open.length === 0) return;

    const mints = open.map((p) => p.tokenAddress);
    // SOL-denominated prices (SOL per whole token) so PnL is tracked in SOL
    // terms — a SOL price move alone doesn't read as token profit/loss.
    const prices = await this.jupiter.getPriceInSol(mints);

    // Force-probe counter: every 6 ticks (30s at 5s interval), probe the swap
    // route even when Price API succeeds. Catches stale-price scenarios where
    // LP is pulled but the Price API still returns a cached non-zero value.
    this.forceProbeTick = (this.forceProbeTick ?? 0) + 1;
    const FORCE_PROBE_INTERVAL = 6; // every 6 ticks = 30s

    for (const pos of open) {
      let price = prices[pos.tokenAddress];

      // Fallback: the Price API doesn't index brand-new Pump.fun bonding-curve
      // tokens (404 from some regions). Before counting a miss, try to derive a
      // price from a Jupiter swap quote, which routes any sellable token. Slower
      // than a price lookup, so only on a miss.
      if (!(price !== undefined && price > 0)) {
        const quoted = await this.jupiter.quotePriceInSol(pos.tokenAddress, pos.decimals ?? 0);
        if (quoted !== null && quoted > 0) {
          price = quoted;
          logger.info('Price via swap-quote fallback', {
            symbol: pos.tokenSymbol,
            token: pos.tokenAddress,
            price,
          });
        }
      }

      // Force-probe: even when Price API succeeds, periodically verify the
      // swap route still exists. If LP was pulled but Price API is stale,
      // this catches it.
      if (price !== undefined && price > 0 && this.forceProbeTick % FORCE_PROBE_INTERVAL === 0) {
        const probePrice = await this.jupiter.quotePriceInSol(pos.tokenAddress, pos.decimals ?? 0);
        if (probePrice === null || probePrice <= 0) {
          pos.routeProbeFailCount = (pos.routeProbeFailCount ?? 0) + 1;
          logger.warn('Force-probe: no route despite valid price', {
            symbol: pos.tokenSymbol,
            routeProbeFails: pos.routeProbeFailCount,
            priceApiPrice: price,
          });
          // After 2 consecutive probe failures, treat as dead (LP likely pulled)
          if (pos.routeProbeFailCount >= 2) {
            logger.warn('Force-probe failed 2x — overriding price to trigger fail-closed', {
              symbol: pos.tokenSymbol,
            });
            price = 0; // fall through to priceFailCount++
          }
        } else {
          pos.routeProbeFailCount = 0; // route confirmed
        }
      }

      if (price !== undefined && price > 0) {
        // ── Price spike guard ───────────────────────────────────────────
        // Jupiter swap-quote can return bogus prices for low-liquidity
        // tokens (known issue).  A single outlier reading (e.g. 2000×
        // spike) sets a fake peakPrice, triggers TP at an impossible PnL,
        // then triggers trailing stop on the next real reading.  Compare
        // new price against the last validated reading and reject if the
        // ratio exceeds MAX_PRICE_RATIO (default 10×).
        const baseline = pos.lastValidPrice ?? pos.currentPrice;
        if (baseline > 0) {
          const ratio = price / baseline;
          const isSpike = ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO);
          if (isSpike) {
            pos.priceSpikeRejectCount = (pos.priceSpikeRejectCount ?? 0) + 1;
            if (pos.priceSpikeRejectCount < MAX_CONSECUTIVE_SPIKE_REJECTS) {
              logger.warn('Price spike rejected', {
                symbol: pos.tokenSymbol,
                oldPrice: baseline,
                newPrice: price,
                ratio: ratio.toFixed(2),
                consecutiveRejects: pos.priceSpikeRejectCount,
              });
              // Don't update currentPrice or peakPrice — keep last valid
              pos.priceFailCount = 0; // it's not a miss, just a bad reading
              continue; // skip to next position
            }
            logger.warn('Price spike accepted after N consecutive rejects — using latest reading', {
              symbol: pos.tokenSymbol,
              newPrice: price,
              consecutiveRejects: pos.priceSpikeRejectCount,
            });
          }
        }
        // Price passed sanity check (or first reading, or forced after N rejects)
        pos.priceSpikeRejectCount = 0;
        pos.lastValidPrice = price;
        pos.currentPrice = price;
        pos.priceFailCount = 0;
        if (price > pos.peakPrice) pos.peakPrice = price;
        const unrealisedSol = (price - pos.entryPrice) / pos.entryPrice * pos.entryAmountSol;
        pos.unrealisedPnlSol = unrealisedSol;

      } else {
        // H4: couldn't price this token this tick (Price API + swap-quote both
        // missed). Count consecutive misses so checkTPSL can fail-closed (sell)
        // rather than hold blind — a token we can no longer quote at all is most
        // likely dead/rugged.
        pos.priceFailCount = (pos.priceFailCount ?? 0) + 1;
      }

      // Smart-money flow: re-fetch the GMGN smart-degen count and alert (no
      // auto-sell) if wallets that were present at entry have fully exited.
      await this.checkSmartMoneyFlow(pos);
    }
    this.savePositions();
  }

  /** Minimum gap between smart-money flow checks per position. */
  private static readonly SMART_MONEY_CHECK_INTERVAL_MS = 60_000;

  /**
   * Post-entry smart-money monitoring. If smart-degen wallets were present at
   * entry (≥1) and have since dropped to 0, log a warning and alert the
   * operator. This is informational only — it does NOT auto-sell. Throttled
   * per position and de-duped so it fires at most once.
   */
  private async checkSmartMoneyFlow(pos: Position): Promise<void> {
    if (!pos.entrySmartDegenCount || pos.entrySmartDegenCount < 1) return;
    if (pos.smartMoneyExitAlerted) return;

    const now = Date.now();
    if (pos.lastSmartMoneyCheckAt &&
        now - pos.lastSmartMoneyCheckAt < PositionManager.SMART_MONEY_CHECK_INTERVAL_MS) {
      return;
    }
    pos.lastSmartMoneyCheckAt = now;

    const info = await this.gmgn.fetchTokenInfo(pos.tokenAddress);
    if (!info) return;

    // M3: distinguish 'field missing from API response' from 'present and 0'.
    // A missing field must NOT be treated as 0 — that would fire a false exit
    // alert. Skip this cycle when the field is absent and wait for a real value.
    const current = info.smartDegenCount;
    if (current === undefined || current === null) return;

    if (current === 0) {
      pos.smartMoneyExitAlerted = true;
      logger.warn('Smart money exiting', {
        symbol: pos.tokenSymbol,
        token: pos.tokenAddress,
        entrySmartDegenCount: pos.entrySmartDegenCount,
        currentSmartDegenCount: current,
      });
      this.onAlert?.(
        `⚠️ Smart money exiting ${pos.tokenSymbol} — was ${pos.entrySmartDegenCount}, now 0 (holding, no auto-sell)`,
      );
    }
  }

  private async checkTPSL(): Promise<void> {
    const cfg = configManager.get();
    const tp = cfg.strategy.takeProfitPct ?? STRATEGY.takeProfitPct;
    const sellPct = cfg.strategy.firstTargetSellPct ?? STRATEGY.firstTargetSellPct;
    const trailDrop = cfg.strategy.trailingStopPct ?? STRATEGY.trailingStopPct;
    const useTrail = cfg.strategy.useTrailingStop ?? STRATEGY.useTrailingStop;
    const sl = cfg.strategy.stopLossPct ?? STRATEGY.stopLossPct;
    const hardSl = cfg.strategy.hardStopLossPct ?? STRATEGY.hardStopLossPct;
    const graceMs = cfg.strategy.slGracePeriodMs ?? STRATEGY.slGracePeriodMs;
    const slConfirms = cfg.strategy.slConfirms ?? STRATEGY.slConfirms;
    const timeoutMs = cfg.strategy.positionTimeoutMs ?? STRATEGY.positionTimeoutMs;

    for (const pos of this.getOpenPositions()) {
      // H3: a sell is already in flight for this position — skip until it settles
      // so a TP and SL (or two TP checks) can't both fire on the same position.
      if (pos.selling) continue;

      // H4: fail-closed on a dark price feed. After PRICE_FAIL_CLOSE_THRESHOLD
      // consecutive ticks with no usable price, sell instead of holding — SL
      // would otherwise be blind on a token that's most likely dead/rugged.
      // Skip during grace period (new positions may not be indexed yet).
      const posAgeMs = Date.now() - new Date(pos.openedAt).getTime();
      const priceFailCloseThreshold = configManager.get().strategy.priceFailCloseThreshold;
      if ((pos.priceFailCount ?? 0) >= priceFailCloseThreshold && posAgeMs > PRICE_FAIL_GRACE_MS) {
        logger.warn('Price feed dark — fail-closed sell', {
          symbol: pos.tokenSymbol,
          token: pos.tokenAddress,
          misses: pos.priceFailCount,
        });
        await this.closePosition(pos.tokenAddress, 'stop_loss');
        continue;
      }

      // Runtime safety monitors (active bundler / developing rug). If either
      // fires the position is auto-closed, so skip the normal TP/SL pass.
      if (await this.runSafetyChecks(pos)) continue;

      const pctChange = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const ageMs = Date.now() - pos.openedAt;
      const inGrace = ageMs < graceMs;

      // Hard SL: always fires, no grace
      if (pctChange <= hardSl) {
        logger.info('Hard SL triggered', { symbol: pos.tokenSymbol, pct: pctChange.toFixed(1) });
        await this.closePosition(pos.tokenAddress, 'stop_loss');
        continue;
      }

      // Soft SL: only after grace, needs confirmation
      if (!inGrace) {
        if (pctChange <= sl) {
          pos.slBelowCount++;
          if (pos.slBelowCount >= slConfirms) {
            logger.info('SL triggered', { symbol: pos.tokenSymbol, pct: pctChange.toFixed(1), confirms: pos.slBelowCount });
            await this.closePosition(pos.tokenAddress, 'stop_loss');
            continue;
          }
        } else {
          pos.slBelowCount = 0; // reset if recovered above SL
        }
      }

      // TP: partial sell + activate trailing
      if (!pos.firstTargetHit && pctChange >= tp) {
        logger.info('TP triggered (partial)', { symbol: pos.tokenSymbol, pct: pctChange.toFixed(1), sellPct });
        const sellOk = await this.partialSell(pos, sellPct, 'take_profit');
        if (sellOk) {
          pos.firstTargetHit = true;
        }
        continue;
      }

      // Trailing TP: close if drops tiered trailDrop% from peak
      if (useTrail && pos.firstTargetHit) {
        const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const effectiveTrail = computeTieredTrailDrop(pnlPct, trailDrop, cfg.strategy);
        const dropFromPeak = ((pos.peakPrice - pos.currentPrice) / pos.peakPrice) * 100;
        if (dropFromPeak >= effectiveTrail) {
          logger.info('Trailing TP triggered', {
            symbol: pos.tokenSymbol,
            peak: pos.peakPrice,
            current: pos.currentPrice,
            drop: dropFromPeak.toFixed(1),
            effectiveTrail,
          });
          await this.closePosition(pos.tokenAddress, 'trailing_stop');
        }
      }

      // Timeout (only flat/losing)
      if (ageMs > timeoutMs && pctChange <= 0) {
        logger.info('Position timeout', { symbol: pos.tokenSymbol });
        await this.closePosition(pos.tokenAddress, 'timeout');
      }
    }
  }

  /**
   * Fast-path trailing check. Runs every TRAILING_CHECK_INTERVAL_MS (2s) for
   * positions with firstTargetHit=true. Fetches a fresh price via swap-quote
   * fallback (Pump.fun tokens aren't indexed by Price API) and checks the
   * trailing stop immediately. This closes the timing gap that caused the
   * EC43 overshoot (-19.2% → -29.4% in one 5s window).
   */
  private async trailingTick(): Promise<void> {
    const cfg = configManager.get();
    const useTrail = cfg.strategy.useTrailingStop ?? STRATEGY.useTrailingStop;
    if (!useTrail) return;

    const trailDrop = cfg.strategy.trailingStopPct ?? STRATEGY.trailingStopPct;
    const trailing = this.getOpenPositions().filter(
      p => p.firstTargetHit && !p.selling
    );
    if (trailing.length === 0) return;

    for (const pos of trailing) {
      // Fetch fresh price via swap-quote (Pump.fun tokens need this)
      const price = await this.jupiter.quotePriceInSol(
        pos.tokenAddress,
        pos.decimals ?? 0
      );
      if (price === null || price <= 0) continue;

      // Spike guard — same logic as updatePrices()
      const baseline = pos.lastValidPrice ?? pos.currentPrice;
      if (baseline > 0) {
        const ratio = price / baseline;
        if (ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO)) {
          logger.debug('Trailing tick: spike rejected', {
            symbol: pos.tokenSymbol,
            old: baseline,
            new: price,
            ratio: ratio.toFixed(2),
          });
          continue;
        }
      }

      // Update price and peak
      pos.currentPrice = price;
      pos.lastValidPrice = price;
      if (price > pos.peakPrice) pos.peakPrice = price;

      // Tiered trailing stop check
      const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const effectiveTrail = computeTieredTrailDrop(pnlPct, trailDrop, cfg.strategy);
      const dropFromPeak = ((pos.peakPrice - pos.currentPrice) / pos.peakPrice) * 100;
      if (dropFromPeak >= effectiveTrail) {
        logger.info('Trailing TP triggered (fast tick)', {
          symbol: pos.tokenSymbol,
          peak: pos.peakPrice,
          current: pos.currentPrice,
          drop: dropFromPeak.toFixed(1),
          effectiveTrail,
          interval: '2s',
        });
        await this.closePosition(pos.tokenAddress, 'trailing_stop');
      }
    }
    this.savePositions();
  }

  /**
   * Periodic liquidity check. Fetches current liquidity from GMGN for all open
   * positions and alerts if liquidity dropped >50% from entry. This catches
   * "delayed rug" scenarios where the dev pulls liquidity after entry.
   */
  private async checkLiquidity(): Promise<void> {
    const open = this.getOpenPositions().filter(p => p.entryLiquidityUsd && p.entryLiquidityUsd > 0);
    if (open.length === 0) return;

    for (const pos of open) {
      try {
        const url = `https://gmgn.ai/defi/quotation/v1/tokens/token_info/${pos.tokenAddress}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) continue;
        const data = await resp.json() as { data?: { liquidity?: number } };
        const currentLiq = data?.data?.liquidity;
        if (!currentLiq || currentLiq <= 0) continue;

        const entryLiq = pos.entryLiquidityUsd!;
        const dropPct = ((entryLiq - currentLiq) / entryLiq) * 100;

        if (dropPct >= 50) {
          logger.warn('Liquidity drop detected', {
            symbol: pos.tokenSymbol,
            entry: entryLiq,
            current: currentLiq,
            dropPct: dropPct.toFixed(1),
          });
          await this.notifyLiquidityDrop(pos, entryLiq, currentLiq, dropPct);
        }
      } catch { /* non-critical, skip */ }
    }
  }

  private async notifyLiquidityDrop(pos: Position, entryLiq: number, currentLiq: number, dropPct: number): Promise<void> {
    const msg = `⚠️ *LIQUIDITY DROP*\n` +
      `Token: ${pos.tokenSymbol}\n` +
      `Entry Liq: $${Math.round(entryLiq).toLocaleString()}\n` +
      `Current Liq: $${Math.round(currentLiq).toLocaleString()}\n` +
      `Drop: -${dropPct.toFixed(0)}%\n\n` +
      `Possible rug pull — consider closing position manually.`;
    try {
      logger.warn('Liquidity alert', { symbol: pos.tokenSymbol, dropPct: dropPct.toFixed(1) });
      if (this.onAlert) this.onAlert(msg);
    } catch { /* non-critical */ }
  }

  /**
   * Throttled runtime safety monitors for a single open position. Detects an
   * ACTIVE bundler transfer-burst (Helius) and a developing rug (GMGN metric
   * divergence from the entry snapshot), and auto-closes the position if either
   * fires. Each check is gated by its config flag and throttled to at most once
   * per `safety.bundlerCheckIntervalMs` (default {@link SAFETY_CHECK_INTERVAL_MS}).
   *
   * Returns true when the position was closed, so the caller skips the normal
   * TP/SL pass for it this cycle. Detector failures never close a position.
   */
  private async runSafetyChecks(pos: Position): Promise<boolean> {
    const safety = configManager.get().safety;
    const intervalMs = safety?.bundlerCheckIntervalMs ?? SAFETY_CHECK_INTERVAL_MS;
    const now = Date.now();

    // ── Active bundler pattern ──
    if (
      safety?.bundlerCheckEnabled !== false &&
      (!pos.lastBundlerCheckAt || now - pos.lastBundlerCheckAt > intervalMs)
    ) {
      pos.lastBundlerCheckAt = now;
      const result = await checkBundlerPattern(pos.tokenAddress, pos.tokenSymbol);
      if (result.isBundler) {
        const runtimeDumpOnly = safety?.bundler?.runtimeDumpOnly !== false;
        const dumpThreshold = safety?.bundler?.dumpPriceDropPct ?? 5;
        const prevPrice = pos.priceAtLastBundlerCheck;
        const curPrice = pos.currentPrice;

        let isDump = true; // default: treat as dump when runtimeDumpOnly is off

        if (runtimeDumpOnly && prevPrice != null && prevPrice > 0 && curPrice > 0) {
          const priceDropPct = ((prevPrice - curPrice) / prevPrice) * 100;
          isDump = priceDropPct >= dumpThreshold;
          if (!isDump) {
            logger.info('Bundler burst detected — accumulation (price stable/rising, NOT closing)', {
              symbol: pos.tokenSymbol,
              token: pos.tokenAddress,
              details: result.details,
              prevPrice,
              curPrice,
              priceDropPct: priceDropPct.toFixed(2) + '%',
              dumpThreshold: dumpThreshold + '%',
            });
            saveBundlerDetection(pos.tokenAddress, pos.tokenSymbol, result, pos.unrealisedPnlSol ?? 0);
          }
        } else if (runtimeDumpOnly && (prevPrice == null || prevPrice <= 0)) {
          // No previous price baseline yet — treat first detection as unknown,
          // don't force-close. The next check will have a baseline.
          logger.info('Bundler burst detected — no price baseline yet, holding (first check)', {
            symbol: pos.tokenSymbol,
            token: pos.tokenAddress,
            details: result.details,
          });
          saveBundlerDetection(pos.tokenAddress, pos.tokenSymbol, result, pos.unrealisedPnlSol ?? 0);
          isDump = false;
        }

        if (isDump) {
          saveBundlerDetection(pos.tokenAddress, pos.tokenSymbol, result, pos.unrealisedPnlSol ?? 0);
          logger.warn('Bundler DUMP detected on open position — auto-closing', {
            symbol: pos.tokenSymbol,
            token: pos.tokenAddress,
            details: result.details,
            prevPrice,
            curPrice,
          });
          await this.closePosition(pos.tokenAddress, 'bundler_detected');
          if (pos.status !== 'open') return true;
        }
      }
      // Always record the current price for the next check's baseline.
      pos.priceAtLastBundlerCheck = pos.currentPrice;
    }

    // ── Developing rug (metric divergence from entry snapshot) ──
    if (
      safety?.rugSignalCheckEnabled !== false &&
      (!pos.lastRugCheckAt || now - pos.lastRugCheckAt > intervalMs)
    ) {
      pos.lastRugCheckAt = now;
      const rug = await this.rugDetector.checkRugSignals(
        pos.tokenAddress,
        pos.gmgnSnapshot,
        pos.tokenSymbol,
      );
      if (rug.isRug) {
        logger.warn('Rug signals detected on open position — auto-closing', {
          symbol: pos.tokenSymbol,
          token: pos.tokenAddress,
          rugScore: rug.rugScore,
          signals: rug.signals,
        });
        await this.closePosition(pos.tokenAddress, 'rug_signal');
        if (pos.status !== 'open') return true;
      }
    }

    return false;
  }

  /**
   * Sell a percentage of a position without closing it. Reduces `tokensReceived`
   * and records the partial sell in trade history; the position stays open so
   * the remaining tokens can ride the trailing stop.
   */
  private async partialSell(pos: Position, sellPct: number, reason: CloseReason): Promise<boolean> {
    // H3: don't start a partial sell while another sell is already in flight.
    if (pos.selling) return false;
    const tokensToSell = Math.floor(pos.tokensReceived * (sellPct / 100));
    if (tokensToSell <= 0) return false;

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      pos.selling = true;
      try {
        const ok = await this.performPartialSell(pos, tokensToSell, sellPct, reason);
        if (ok) return true;
      } finally {
        pos.selling = false;
      }

      // If this was the last attempt, give up
      if (attempt >= MAX_RETRIES) break;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn('Partial sell failed, retrying', {
        symbol: pos.tokenSymbol,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        nextRetryMs: delay,
      });
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }

    // All retries exhausted
    pos.partialSellFailed = true;
    const pctChange = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    this.onAlert?.(
      `⚠️ TP detected for ${pos.tokenSymbol} at +${pctChange.toFixed(1)}% but partial sell failed after ${MAX_RETRIES} retries. Bot will continue monitoring with trailing stop.`
    );
    logger.error('Partial sell failed after all retries', {
      symbol: pos.tokenSymbol,
      retries: MAX_RETRIES,
    });
    return false;
  }

  private async performPartialSell(pos: Position, tokensToSell: number, sellPct: number, reason: CloseReason): Promise<boolean> {
    const result = await this.engine.sell(pos.tokenAddress, tokensToSell);
    if (!result.success) {
      // Even if the sell "failed", the tx may have landed on-chain but
      // confirmation timed out. Sync from actual on-chain balance.
      const onChainBalance = await getTokenBalance(pos.tokenAddress);
      let tokensActuallySold = onChainBalance < pos.tokensReceived;
      if (tokensActuallySold) {
        // Tokens were sold — update tracked amount to reflect reality
        logger.warn('Partial sell reported failure but balance decreased — syncing', {
          symbol: pos.tokenSymbol,
          tracked: pos.tokensReceived,
          onChain: onChainBalance,
        });
        pos.tokensReceived = onChainBalance;
        if (onChainBalance === 0) {
          // All tokens gone — close position
          logger.warn('On-chain balance is 0 after partial sell failure — closing position', {
            symbol: pos.tokenSymbol,
          });
          pos.status = 'closed';
          pos.closedAt = Date.now();
          pos.tokensReceived = 0;
          pos.closeReason = reason;
          this.positions.delete(pos.tokenAddress);
          this.onClose?.(pos);
        }
      } else {
        logger.error('Partial sell failed', { symbol: pos.tokenSymbol, sellPct, reason, error: result.error });
      }
      this.savePositions();
      return tokensActuallySold;
    }

    const solReceived = Math.abs(result.solSpent ?? 0);

    // Sync remaining tokens from actual on-chain balance to avoid drift
    // from slippage or timeout scenarios.
    try {
      const onChainBalance = await getTokenBalance(pos.tokenAddress);
      pos.tokensReceived = onChainBalance;
    } catch {
      // Fallback to arithmetic if RPC fails
      pos.tokensReceived -= tokensToSell;
    }

    // If all tokens are gone, close the position entirely instead of
    // leaving a zero-balance stub that will fail on trailing stop.
    if (pos.tokensReceived <= 0) {
      logger.info('Partial sell exhausted all tokens — closing position', {
        symbol: pos.tokenSymbol,
        reason,
      });
      pos.status = 'closed';
      pos.closedAt = Date.now();
      pos.tokensReceived = 0;
      pos.closeReason = reason;

      const buyPf = pos.buyPriorityFeeSol ?? 0;
      const sellPf = configManager.get().strategy.priorityFeeLamports / 1_000_000_000;
      const costBasis = pos.entryAmountSol * (sellPct / 100);
      const buyPfPortion = buyPf * (sellPct / 100);
      const partialPnlSol = solReceived - costBasis - buyPfPortion - sellPf;
      const partialPnlPct = (partialPnlSol / costBasis) * 100;
      // This partial sell exhausted the position — set realisedPnlSol so the
      // close handler feeds the correct PnL to the risk manager.
      pos.realisedPnlSol = partialPnlSol;
      const trade: TradeRecord = {
        positionId: pos.id,
        tokenAddress: pos.tokenAddress,
        tokenSymbol: pos.tokenSymbol,
        side: 'sell',
        amountSol: solReceived,
        price: pos.currentPrice,
        txSig: result.txSig ?? '',
        timestamp: Date.now(),
        pnlSol: partialPnlSol,
        pnlPct: partialPnlPct,
        closeReason: reason,
        priorityFee: sellPf,
      };
      this.history.record(trade);
      this.positions.delete(pos.tokenAddress);
      this.savePositions();
      this.onClose?.(pos);
      return true;
    }

    logger.info('Partial sell executed', {
      symbol: pos.tokenSymbol,
      reason,
      sellPct,
      tokensSold: tokensToSell,
      remaining: pos.tokensReceived,
      solReceived: solReceived.toFixed(4),
    });

    const buyPf2 = pos.buyPriorityFeeSol ?? 0;
    const sellPf2 = configManager.get().strategy.priorityFeeLamports / 1_000_000_000;
    const costBasis2 = pos.entryAmountSol * (sellPct / 100);
    const buyPfPortion2 = buyPf2 * (sellPct / 100);
    const partialPnlSol2 = solReceived - costBasis2 - buyPfPortion2 - sellPf2;
    const partialPnlPct2 = (partialPnlSol2 / costBasis2) * 100;
    const trade: TradeRecord = {
      positionId: pos.id,
      tokenAddress: pos.tokenAddress,
      tokenSymbol: pos.tokenSymbol,
      side: 'sell',
      amountSol: solReceived,
      price: pos.currentPrice,
      txSig: result.txSig ?? '',
      timestamp: Date.now(),
      pnlSol: partialPnlSol2,
      pnlPct: partialPnlPct2,
      closeReason: reason,
      priorityFee: sellPf2,
    };
    this.history.record(trade);

    // H3: feed the realized PnL of the sold slice to the risk manager. The
    // position stays open, so the full-close handler won't see this slice.
    this.onPartialClose?.(partialPnlSol2);

    // Reduce cost basis AFTER recording so remaining position's PnL is
    // calculated correctly in performClose (trailing stop / SL).
    // Also reduce the buy priority fee proportionally.
    pos.entryAmountSol -= pos.entryAmountSol * (sellPct / 100);
    pos.buyPriorityFeeSol = (pos.buyPriorityFeeSol ?? 0) * (1 - sellPct / 100);

    this.savePositions();
    return true;
  }
}
