import * as fs from 'fs';
import * as path from 'path';
import { ENV, IS_PRODUCTION, STRATEGY, SCREENING } from './config/config.js';
import { TokenInfo, Position, GmgnSnapshot } from './types/index.js';
import { GmgnClient } from './discovery/GmgnClient.js';
import { TokenDiscovery } from './discovery/TokenDiscovery.js';
import { TokenFilter } from './screening/TokenFilter.js';
import { RugChecker } from './screening/RugChecker.js';
import { RiskManager } from './risk/RiskManager.js';
import { ExecutionEngine } from './execution/ExecutionEngine.js';
import { JupiterClient } from './execution/JupiterClient.js';
import { PositionManager } from './position/PositionManager.js';
import { TradeHistory } from './logger/TradeHistory.js';
import { TelegramBot } from './telegram/TelegramBot.js';
import { DryRunLogger } from './dryrun/DryRunLogger.js';
import { themeKey } from './screening/themeKey.js';
import { getWallet, getWalletBalanceSol, checkMintAuthority } from './utils/solana.js';
import { LAMPORTS_PER_SOL, WSOL_MINT } from './config/constants.js';
import { logger } from './logger/Logger.js';
import { configManager } from './config/ConfigManager.js';

/**
 * Top-level orchestrator. Wires discovery → screening → risk → execution →
 * position management, exposes runtime control through the Telegram bot, and
 * coordinates a clean shutdown.
 *
 * Candidate processing is serialized through a promise chain so the risk
 * gate (concurrency / sizing / loss limits) is evaluated against a stable
 * snapshot — concurrent buys can't race past the limits.
 */
class SniperBot {
  private readonly discovery: TokenDiscovery;
  private readonly filter = new TokenFilter();
  private readonly rugChecker = new RugChecker();
  private readonly jupiter = new JupiterClient();
  private readonly risk = new RiskManager();
  private readonly engine = new ExecutionEngine();
  private readonly history = new TradeHistory();
  private readonly positions: PositionManager;
  private readonly telegram: TelegramBot;
  private readonly dryRunLogger = new DryRunLogger();

  /** Tail of the candidate-processing chain — keeps buys strictly sequential. */
  private processChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  /**
   * Addresses we've notified on very recently. Guards against the same token
   * being notified twice when discovery re-emits it across polls faster than a
   * signal can flip out of 'open' (or before enrichment finishes). Entries
   * self-expire after RECENT_NOTIFY_TTL_MS. This is intentionally separate from
   * both the discovery dedupe window and the DryRunLogger 'open' dedup — it
   * closes the gap between candidate intake and the signal being recorded.
   */
  private readonly recentlyNotified = new Map<string, NodeJS.Timeout>();
  private static readonly RECENT_NOTIFY_TTL_MS = 60_000;

  /**
   * Tokens we've recently traded (bought + sold). Prevents re-entering the same
   * token within a cooldown window after closing — avoids buying back into a
   * dump or a token that already showed weakness.
   */
  private readonly recentlyTraded = new Map<string, number>();
  private static readonly RECENTLY_TRADED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
  private static readonly RECENTLY_TRADED_FILE = path.join(process.cwd(), 'data', 'recently-traded.json');

  /**
   * Tokens whose buy tx is currently in-flight. Prevents two candidates for
   * the same token address (discovered in the same poll cycle) from both
   * passing the dedup checks and opening duplicate positions. Cleared on
   * buy completion (success or failure).
   */
  private readonly currentlyBuying = new Set<string>();

  /** Minimum viable position size — below this, fees dominate, so skip. */
  private static readonly DUST_FLOOR_SOL = 0.005;

  constructor() {
    this.discovery = new TokenDiscovery(new GmgnClient());
    this.positions = new PositionManager(this.engine, this.history);
    this.telegram = new TelegramBot(this.positions, this.risk, this.history, this.engine, this.dryRunLogger);
    this.loadRecentlyTraded();
  }

  async start(): Promise<void> {
    this.banner();

    // Load + validate the wallet up front so a bad PRIVATE_KEY fails fast.
    const wallet = getWallet();
    let balance = 0;
    try {
      balance = await getWalletBalanceSol();
      this.risk.setStartingBalance(balance);
    } catch (err) {
      logger.warn('Could not fetch wallet balance at startup', { err: String(err) });
    }

    logger.info('Wallet ready', {
      pubkey: wallet.publicKey.toBase58(),
      balanceSol: balance.toFixed(4),
    });

    // Position close → update risk streak + notify.
    this.positions.onPositionClosed((pos) => this.handlePositionClosed(pos));
    // Partial sell (position stays open) → feed the sold slice's PnL to risk.
    this.positions.onPartialSell((pnlSol) => this.handlePartialSell(pnlSol));
    this.positions.onAlertHandler((msg) => this.safeNotify(msg));

    // Discovery candidate → screen + (in autonomous mode) trade.
    this.discovery.on('candidate', (token) => {
      this.processChain = this.processChain
        .then(() => this.processCandidate(token))
        .catch((err) => {
          logger.error('Candidate processing failed', { err: String(err), stack: err instanceof Error ? err.stack : 'no stack' });
        });
    });
    this.discovery.on('error', (err) => {
      logger.error('Discovery error', { err: err.message });
    });

    // Start background services. Telegram begins in 'stopped' mode; the operator
    // sends /start to arm autonomous trading.
    this.positions.start();
    await this.telegram.start();
    this.discovery.start();
    this.startDryRunPriceMonitor();

    await this.telegram.notify(
      `🤖 *GMGN Sniper online* ${IS_PRODUCTION ? '(PRODUCTION)' : '(TEST)'}\n` +
        `Wallet: \`${wallet.publicKey.toBase58()}\`\n` +
        `Balance: ${balance.toFixed(4)} SOL\n\n` +
        'Send /start to arm autonomous trading, /help for commands.',
    );

    this.registerShutdownHooks();
    logger.info('Bot started — awaiting /start for autonomous mode');
  }

  /**
   * Screen a single discovered token and, when armed, open a position. Runs
   * inside the serialized process chain so risk checks see a consistent state.
   */
  /**
   * Context-aware sizing layered on top of the risk manager's base size:
   *  - Adaptive: scale by recent win rate over the last 20 sells (down when
   *    cold, up when hot).
   *  - Time-of-day: halve size during 00:00–08:00 UTC (low-volume hours).
   * Result is clamped to the per-trade ceiling.
   */
  private adjustPositionSize(baseSizeSol: number): number {
    const cfg = configManager.get();
    let size = baseSizeSol;

    if (cfg.sizing.adaptiveSizingEnabled) {
      const recent = this.history.getRecentSells(20).filter((t) => t.pnlSol !== undefined);
      if (recent.length > 0) {
        // H4: a single token can produce multiple sell rows (partial TP + final
        // close). Counting each row inflates the win rate, so aggregate PnL per
        // token and treat each unique token as one win/loss by its net PnL.
        const byToken = new Map<string, number>();
        for (const t of recent) {
          byToken.set(t.tokenAddress, (byToken.get(t.tokenAddress) ?? 0) + (t.pnlSol ?? 0));
        }
        const wins = [...byToken.values()].filter((pnl) => pnl > 0).length;
        const winRate = wins / byToken.size;
        if (winRate <= cfg.sizing.lowWinRateThreshold) {
          size *= cfg.sizing.lowWinRateMultiplier;
          logger.info('Adaptive sizing: low recent win rate — scaling down', {
            winRate: winRate.toFixed(2), trades: recent.length, multiplier: cfg.sizing.lowWinRateMultiplier,
          });
        } else if (winRate >= cfg.sizing.highWinRateThreshold) {
          size *= cfg.sizing.highWinRateMultiplier;
          logger.info('Adaptive sizing: high recent win rate — scaling up', {
            winRate: winRate.toFixed(2), trades: recent.length, multiplier: cfg.sizing.highWinRateMultiplier,
          });
        }
      }
    }

    if (cfg.sizing.timeAwarenessEnabled) {
      const utcHour = new Date().getUTCHours();
      if (utcHour < 8) {
        size *= 0.5;
        logger.info('Time-of-day sizing: low-volume UTC hours — halving size', { utcHour });
      }
    }

    const maxPerTrade = cfg.risk.maxPerTradeSol;
    if (maxPerTrade > 0 && size > maxPerTrade) size = maxPerTrade;

    // M6: dust floor — below this, fees dominate the trade. Return 0 so the
    // caller skips the candidate entirely rather than opening a dust position.
    if (size < SniperBot.DUST_FLOOR_SOL) {
      logger.info('Position size below dust floor — skipping trade', {
        size: size.toFixed(5),
        floor: SniperBot.DUST_FLOOR_SOL,
      });
      return 0;
    }
    return size;
  }

  private async processCandidate(token: TokenInfo): Promise<void> {
    if (this.shuttingDown) return;
    if (this.telegram.getMode() !== 'autonomous') return;
    if (this.positions.hasPosition(token.address)) return;
    // Block tokens whose buy tx is already in-flight (same-cycle race guard)
    if (this.currentlyBuying.has(token.address)) {
      logger.debug('Skip: already buying this cycle', { symbol: token.symbol, address: token.address });
      return;
    }
    // Block tokens recently traded (sold within cooldown window)
    const tradedAt = this.recentlyTraded.get(token.address);
    if (tradedAt && Date.now() - tradedAt < SniperBot.RECENTLY_TRADED_TTL_MS) {
      logger.debug('Skip: recently traded', { symbol: token.symbol, address: token.address });
      return;
    }
    // Already notified within the last minute — drop the duplicate before we
    // spend an enrichment round-trip on it.
    if (this.recentlyNotified.has(token.address)) {
      logger.debug('Skip: notified recently', { symbol: token.symbol, address: token.address });
      return;
    }

    // ── Quantitative screening gate ──────────────────────────────────────
    // Cheapest gate first — no network calls — so we only spend an RPC read
    // and a Jupiter quote on candidates that already clear the numeric filter.
    const screen = this.filter.filter(token);
    if (!screen.passed) {
      logger.debug('Skip: failed screening', { symbol: token.symbol, reasons: screen.reasons });
      return;
    }

    // ── Volume confirmation before entry ─────────────────────────────────
    // A passing score on dead or crashing volume is a value trap: skip tokens
    // with no 24h volume or a >10% 5m drop even if they cleared screening.
    if (!(token.volume24h > 0) || token.priceChange5m <= -10) {
      logger.info('Skip: volume dead or price crashing', {
        symbol: token.symbol,
        volume24h: token.volume24h,
        priceChange5m: token.priceChange5m,
      });
      return;
    }

    // ── Rug gate (on-chain verified authorities) ─────────────────────────
    // GMGN's renounce flags are stale for fresh Pump.fun tokens, so read the
    // mint/freeze authorities straight from chain and let RugChecker use them
    // as the source of truth (it falls back to the API flags if the RPC fails).
    const onChain = await checkMintAuthority(token.address);
    const rug = this.rugChecker.check(token, onChain);
    if (rug.isRug) {
      logger.debug('Skip: rug detected', { symbol: token.symbol, flags: rug.flags });
      return;
    }

    // ── GMGN safety-flag enforcement ─────────────────────────────────────
    // These flags come from GMGN's API (zero latency cost) and are already
    // on the token object. Enforce as hard rejection criteria.
    if (token.isHoneypot === true) {
      logger.info('Skip: GMGN honeypot flag', { symbol: token.symbol, address: token.address });
      return;
    }
    if (token.isWashTrading === true) {
      logger.info('Skip: GMGN wash trading flag', { symbol: token.symbol, address: token.address });
      return;
    }
    if ((token.bundlerRate ?? 0) > 0.5) {
      logger.info('Skip: high bundler rate', { symbol: token.symbol, bundlerRate: token.bundlerRate });
      return;
    }

    const sizeSol = this.adjustPositionSize(this.risk.getPositionSizeSol());
    // M6: adjustPositionSize returns 0 when the sized trade is below the dust
    // floor — skip the candidate so we never open a fee-dominated position.
    if (sizeSol <= 0) {
      logger.info('Skip: position size below dust floor', { symbol: token.symbol });
      return;
    }

    // ── Anti-honeypot: simulate selling the position back to SOL ──────────
    if (STRATEGY.simulateSellBeforeBuy) {
      const canSellBackMinAgeMs = configManager.get().strategy.canSellBackMinAgeMs;
      const tokenAgeMs = token.createdAt > 0 ? (Date.now() / 1000 - token.createdAt) * 1000 : Infinity;
      if (tokenAgeMs < canSellBackMinAgeMs) {
        logger.debug('Skipping canSellBack: token too new', {
          symbol: token.symbol,
          tokenAgeMs: Math.round(tokenAgeMs),
          minAgeMs: canSellBackMinAgeMs,
        });
      } else if (!(await this.canSellBack(token, sizeSol))) {
        return;
      }
    }

    // ── Risk gate ────────────────────────────────────────────────────────
    const verdict = this.risk.canTrade(this.positions.getOpenCount(), sizeSol);
    if (!verdict.allowed) {
      logger.info('Skip: risk gate', { symbol: token.symbol, reason: verdict.reason });
      return;
    }

    // ── Wallet balance gate (live only) ─────────────────────────────────
    if (!configManager.isDryRun()) {
      const { priorityFeeLamports } = configManager.get().strategy;
      const requiredSol = sizeSol + (priorityFeeLamports / 1_000_000_000) + 0.005;
      let currentBalance = 0;
      try {
        currentBalance = await getWalletBalanceSol();
      } catch (err) {
        logger.warn('Could not fetch wallet balance — skipping candidate', { err: String(err) });
        return;
      }
      if (currentBalance < requiredSol) {
        logger.warn('Skip: insufficient wallet balance', {
          symbol: token.symbol,
          balance: currentBalance.toFixed(4),
          required: requiredSol.toFixed(4),
        });
        return;
      }
    }

    // ── Execute ──────────────────────────────────────────────────────────
    logger.info(configManager.isDryRun() ? '[DRY RUN] Would snipe' : 'Sniping candidate', {
      symbol: token.symbol,
      address: token.address,
      score: screen.score,
      sizeSol,
    });

    // ── Pre-execution price recheck (anti-dump) ───────────────────────
    // Compare the on-chain price (via Jupiter quote) against GMGN's reported
    // price right before buying. GMGN's `/v1/token/info` endpoint does NOT
    // return `priceChange5m`, so a recheck based on that field always passes.
    // Instead we get a real Jupiter buy quote and compute the implied per-token
    // USD price, then compare it to GMGN's `token.price`.
    if (!configManager.isDryRun()) {
      try {
        const amountLamports = BigInt(Math.round(sizeSol * LAMPORTS_PER_SOL));
        const quote = await this.jupiter.getQuote(
          WSOL_MINT, token.address, amountLamports, 100, // 1% slippage for tight recheck quote
        );
        if (quote && token.price > 0 && token.decimals >= 0) {
          const outTokensRaw = Number(quote.outAmount);
          const solUsd = await this.solUsdPrice();
          if (outTokensRaw > 0 && solUsd > 0) {
            const tokensWhole = outTokensRaw / 10 ** token.decimals;
            const impliedPriceUsd = (sizeSol * solUsd) / tokensWhole;
            const priceDiffPct = ((token.price - impliedPriceUsd) / token.price) * 100;

            // Check 1: on-chain price is >15% below GMGN's reported price
            if (priceDiffPct > 15) {
              logger.info('ABORT: on-chain price lower than GMGN (price recheck)', {
                symbol: token.symbol,
                address: token.address,
                gmgnPriceUsd: token.price.toExponential(4),
                jupiterImpliedUsd: impliedPriceUsd.toExponential(4),
                diffPct: priceDiffPct.toFixed(1) + '%',
              });
              return;
            }

            // Check 2: Jupiter price impact too high (low liquidity / dumping)
            const priceImpact = parseFloat(quote.priceImpactPct) * 100;
            if (Number.isFinite(priceImpact) && priceImpact > 10) {
              logger.info('ABORT: Jupiter price impact too high (recheck)', {
                symbol: token.symbol,
                address: token.address,
                priceImpactPct: priceImpact.toFixed(1) + '%',
              });
              return;
            }

            logger.debug('Pre-execution recheck passed', {
              symbol: token.symbol,
              gmgnPriceUsd: token.price.toExponential(4),
              jupiterImpliedUsd: impliedPriceUsd.toExponential(4),
              diffPct: priceDiffPct.toFixed(1) + '%',
              priceImpactPct: Number.isFinite(priceImpact) ? priceImpact.toFixed(2) + '%' : 'N/A',
            });
          } else {
            logger.warn('Pre-execution recheck: zero output from Jupiter quote', {
              symbol: token.symbol,
              outTokensRaw,
              solUsd,
            });
          }
        } else if (!quote) {
          logger.warn('Pre-execution recheck: no Jupiter route found — proceeding with caution', {
            symbol: token.symbol,
          });
        }
      } catch (err) {
        logger.warn('Pre-execution recheck failed — proceeding with caution', {
          symbol: token.symbol,
          err: String(err),
        });
      }
    }

    if (configManager.isDryRun()) {
      // Enrich with detailed GMGN info for a richer notification. The rank feed
      // (token) is the source of truth for market_cap / price / volume; the
      // token-info feed only fills in fields it's missing, so it can never wipe
      // out the rank feed's market cap. See GmgnClient.mergeEnrichment.
      const detail = await this.discovery.client.fetchTokenInfo(token.address);
      const enriched = GmgnClient.mergeEnrichment(token, detail);

      logger.debug('Enrichment', {
        symbol: enriched.symbol,
        tokenMcap: token.marketCap,
        detailMcap: detail?.marketCap,
        enrichedMcap: enriched.marketCap,
        enrichedPrice: enriched.price,
      });

      // SOL-denominated price and MC
      const solUsd = await this.solUsdPrice();
      configManager.setSolPriceUsd(solUsd);

      const bsRatio = enriched.buys && enriched.sells
        ? `${(enriched.buys / enriched.sells).toFixed(1)}x`
        : '—';

      const top10Str = enriched.top10HolderPercent != null
        ? `${enriched.top10HolderPercent.toFixed(1)}%`
        : '—';

      const scoreItems: string[] = [];
      if (enriched.holderCount) scoreItems.push(`• ${enriched.holderCount} holders`);
      if (enriched.volume24h) scoreItems.push(`• ${formatUsd(enriched.volume24h)} vol`);
      if (bsRatio !== '—') scoreItems.push(`• B/S ${bsRatio}`);
      scoreItems.push(`• top10 ${top10Str}`);
      if (enriched.mintAuthRevoked) scoreItems.push('• renounced');

      const msg = this.buildSignalMessage(
        '🔍 DRY RUN — Signal Detected',
        enriched, solUsd, screen.score, scoreItems,
      );

      // Track the dry-run entry in SOL terms (SOL per whole token) to mirror
      // the live path — `enriched.price` is USD, so divide by the live SOL/USD.
      const entryPriceSol = enriched.price > 0 && solUsd > 0 ? enriched.price / solUsd : 0;

      // Log signal first — dedup check prevents duplicate notifications
      const isNew = this.dryRunLogger.logSignal({
        symbol: enriched.symbol,
        address: enriched.address,
        marketCap: enriched.marketCap,
        volume24h: enriched.volume24h,
        holders: enriched.holderCount ?? 0,
        ageMinutes: enriched.createdAt ? Math.floor((Date.now() / 1000 - enriched.createdAt) / 60) : 0,
        buysSells: `${enriched.buys ?? '—'}/${enriched.sells ?? '—'}`,
        score: screen.score,
        scoreBreakdown: scoreItems,
        washTrading: enriched.washTrading ?? false,
        bundlerPct: enriched.bundlerRate != null ? enriched.bundlerRate * 100 : 0,
        top10Pct: enriched.top10HolderPercent ?? 0,
        devHoldingPct: enriched.devTeamHoldRate != null ? enriched.devTeamHoldRate * 100 : 0,
        entryPrice: entryPriceSol,
        gmgnLink: `https://gmgn.ai/sol/token/${enriched.address}`,
      });
      if (isNew) {
        this.markNotified(enriched.address);
        // Block cohort for dry-run too — prevents emitting siblings after a signal.
        this.discovery.blockCohort(themeKey(token), 10 * 60 * 1000);
        await this.telegram.notify(msg);
      }
      return;
    }

    // ── Execution lock: prevent duplicate buys of the same token ──────
    this.currentlyBuying.add(token.address);
    try {
      const result = await this.engine.buy(token.address, sizeSol);
      if (!result.success) {
        logger.warn('Buy failed', { symbol: token.symbol, error: result.error });
        return;
      }

    // SOL-denominated entry price (SOL per whole token) so PnL is tracked in
    // SOL terms. `tokensReceived` is in base units, so scale by decimals to get
    // whole tokens — the same per-whole-token basis JupiterClient.getPriceInSol
    // returns for the live mark. This is the *executed* price (incl. slippage),
    // not the GMGN mid (`token.price`, which is USD).
    const tokensReceived = result.tokensReceived ?? 0;
    const dec = Number.isFinite(token.decimals) ? token.decimals : 0;
    const tokensUi = tokensReceived / 10 ** dec;
    const entryPriceSol = tokensUi > 0 ? sizeSol / tokensUi : 0;

    // H2: snapshot the GMGN metrics at entry so the runtime rug-signal detector
    // has an entry baseline to compare against (it no-ops without one).
    const gmgnSnapshot: GmgnSnapshot = {
      holders: token.holderCount ?? 0,
      liquidity: token.liquidity ?? 0,
      top10: token.top10HolderPercent ?? 0,
      entrapment: token.entrapmentRatio ?? 0,
      creatorHold: token.creatorHoldRate ?? 0,
      freshWallet: token.freshWalletRate ?? 0,
      bundlerRate: token.bundlerRate ?? 0,
      snapshotAt: Date.now(),
    };

    await this.positions.openPosition(
      token.address,
      token.symbol,
      entryPriceSol,
      sizeSol,
      tokensReceived,
      result.txSig ?? '',
      dec,
      token.marketCap,
      token.liquidity,
      themeKey(token),
      token.smartDegenCount,
      gmgnSnapshot,
    );

    this.markNotified(token.address);
    const solUsdLive = await this.solUsdPrice();
    const liveMsg = this.buildSignalMessage(
      '🎯 Position Opened',
      token, solUsdLive, undefined, undefined,
      entryPriceSol, sizeSol, result.txSig ?? '',
    );
    await this.telegram.notify(liveMsg);
    } finally {
      this.currentlyBuying.delete(token.address);
    }
  }

  /**
   * Anti-honeypot probe. Quotes selling a position-sized amount of the token
   * back to SOL via Jupiter and rejects the candidate if there's no sell route
   * or the price impact exceeds the configured ceiling. A token we can't quote
   * a sell for is treated as un-sellable (honeypot) and blocked.
   */
  private async canSellBack(token: TokenInfo, sizeSol: number): Promise<boolean> {
    const amount = this.estimateSellBaseUnits(token, sizeSol);
    if (amount <= 0n) {
      // Can't size the probe (no price/decimals) — don't block on our own gap.
      return true;
    }

    const impactPct = await this.jupiter.getSellPriceImpactPct(
      token.address,
      amount,
      STRATEGY.sellSlippageBps,
    );
    if (impactPct === null) {
      logger.info('Skip: no sell route (honeypot risk)', {
        symbol: token.symbol,
        address: token.address,
      });
      return false;
    }
    if (impactPct > STRATEGY.maxSellPriceImpactPct) {
      logger.info('Skip: sell price impact too high (honeypot risk)', {
        symbol: token.symbol,
        impactPct: impactPct.toFixed(1),
        max: STRATEGY.maxSellPriceImpactPct,
      });
      return false;
    }
    return true;
  }

  /**
   * Approximate token base units worth `sizeSol` SOL, used to size the sell
   * simulation so its price impact reflects an actual exit. Falls back to one
   * whole token, then to 0 (un-sizable) when price/decimals are missing.
   */
  private estimateSellBaseUnits(token: TokenInfo, sizeSol: number): bigint {
    if (!(token.decimals >= 0)) return 0n;
    const scale = 10 ** token.decimals;

    if (token.price > 0) {
      const usd = sizeSol * SCREENING.solPriceUsd;
      const base = (usd / token.price) * scale;
      if (Number.isFinite(base) && base >= 1) return BigInt(Math.floor(base));
    }
    return BigInt(Math.floor(scale));
  }

  /** Build the rich signal notification message used by both dry-run and live paths. */
  private buildSignalMessage(
    header: string,
    token: TokenInfo,
    solUsd: number,
    score?: number,
    scoreItems?: string[],
    entryPriceSol?: number,
    sizeSol?: number,
    txSig?: string,
  ): string {
    const ageMin = token.createdAt
      ? Math.floor((Date.now() / 1000 - token.createdAt) / 60)
      : null;
    const ageStr = ageMin != null
      ? ageMin < 60 ? `${ageMin}min` : `${Math.floor(ageMin / 60)}h`
      : 'N/A';

    const mcapK = formatUsd(token.marketCap);
    const volK = formatUsd(token.volume24h);
    const priceStr = token.price
      ? `$${formatPrice(token.price)}`
      : 'N/A';
    const priceSolStr = token.price > 0 && solUsd > 0
      ? `◎${formatPrice(token.price / solUsd)}`
      : 'N/A';
    const mcapSolStr = token.marketCap > 0 && solUsd > 0
      ? `◎${(token.marketCap / solUsd).toFixed(1)}`
      : 'N/A';

    const buyCnt = token.buys ?? '—';
    const sellCnt = token.sells ?? '—';

    const washStr = token.washTrading ? '⚠\ufe0f Yes' : '✅ No';
    const bundlerStr = token.bundlerRate != null
      ? `${(token.bundlerRate * 100).toFixed(1)}%`
      : '—';
    const top10Str = token.top10HolderPercent != null
      ? `${token.top10HolderPercent.toFixed(1)}%`
      : '—';
    const devStr = token.devTeamHoldRate != null
      ? `${(token.devTeamHoldRate * 100).toFixed(1)}%`
      : '—';
    const entrapStr = token.entrapmentRatio != null
      ? `${(token.entrapmentRatio * 100).toFixed(1)}%`
      : '—';
    const smartDegen = token.smartDegenCount ?? 0;
    const snipers = token.sniperCount ?? 0;
    const hotLevel = token.hotLevel ?? 0;
    const change5m = token.priceChange5m;
    const change1h = token.priceChange1h;
    const change5mStr = `${change5m >= 0 ? '+' : ''}${change5m.toFixed(1)}%`;
    const change1hStr = `${change1h >= 0 ? '+' : ''}${change1h.toFixed(1)}%`;

    const symClean = token.symbol.replace(/[*_[\]()~` + "`" + `>#+=|{}.!\\-]/g, '');

    let msg =
      `*${header}*\n\n` +
      `*${symClean}*\n` +
      `\`${token.address}\`\n\n` +
      `💰 Price: ${priceStr} (${priceSolStr})\n\n` +
      `📊 MC: ${mcapK} / ${mcapSolStr}\n` +
      `📈 Volume: ${volK}\n` +
      `💧 Liquidity: ${formatUsd(token.liquidity)}\n` +
      `👥 Holders: ${token.holderCount ?? '—'}\n` +
      `⏳ Age: ${ageStr}\n` +
      `🛒 Buys/Sells: ${buyCnt}/${sellCnt}\n` +
      `📈 5m: ${change5mStr} | 1h: ${change1hStr}\n\n`;

    if (score != null && scoreItems) {
      msg +=
        `⭐ Score: ${score}/100\n` +
        scoreItems.join('\n') + '\n\n';
    }

    msg +=
      `🛡\ufe0f Safety\n` +
      `Wash Trading: ${washStr}\n` +
      `Bundler: ${bundlerStr}\n` +
      `Top 10 Holders: ${top10Str}\n` +
      `Entrapment: ${entrapStr}\n` +
      `Dev Holding: ${devStr}\n\n` +
      `🧠 Signals\n` +
      `Smart Degens: ${smartDegen}\n` +
      `Snipers: ${snipers}\n` +
      `Hot Level: ${hotLevel}/3\n\n` +
      `🔗 [GMGN](https://gmgn.ai/sol/token/${token.address})`;

    if (entryPriceSol != null && sizeSol != null) {
      const cfg = configManager.get();
      msg +=
        `\n\n🎯 Entry: ◎${entryPriceSol.toPrecision(4)}/token\n` +
        `💰 Size: ${sizeSol.toFixed(4)} SOL\n` +
        `📈 TP/SL: +${cfg.strategy.takeProfitPct}% (sell ${cfg.strategy.firstTargetSellPct}%, trail ${cfg.strategy.trailingStopPct}%) / ${cfg.strategy.stopLossPct}% (hard ${cfg.strategy.hardStopLossPct}%)`;
      if (txSig) {
        msg += `\n📝 Tx: \`${txSig}\``;
      }
    }

    return msg;
  }

  /**
   * Record that `address` was just notified and schedule its expiry. Refreshes
   * the timer if it's already tracked so the 60s window starts from the latest
   * notification.
   */
  private markNotified(address: string): void {
    const existing = this.recentlyNotified.get(address);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.recentlyNotified.delete(address);
    }, SniperBot.RECENT_NOTIFY_TTL_MS);
    timer.unref?.();
    this.recentlyNotified.set(address, timer);
  }

  private loadRecentlyTraded(): void {
    try {
      if (!fs.existsSync(SniperBot.RECENTLY_TRADED_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(SniperBot.RECENTLY_TRADED_FILE, 'utf-8'));
      const now = Date.now();
      for (const [addr, ts] of Object.entries(raw)) {
        if (now - (ts as number) < SniperBot.RECENTLY_TRADED_TTL_MS) {
          this.recentlyTraded.set(addr, ts as number);
        }
      }
      logger.info('Loaded recently traded tokens', { count: this.recentlyTraded.size });
    } catch { /* non-critical */ }
  }

  private saveRecentlyTraded(): void {
    try {
      const dir = path.dirname(SniperBot.RECENTLY_TRADED_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, number> = {};
      for (const [addr, ts] of this.recentlyTraded) obj[addr] = ts;
      fs.writeFileSync(SniperBot.RECENTLY_TRADED_FILE, JSON.stringify(obj, null, 2));
    } catch { /* non-critical */ }
  }

  /**
   * Feed a partial sell's realized PnL into the risk manager. The position
   * stays open, so this slice's PnL would otherwise never reach risk tracking
   * (the close handler only sees the remaining slice).
   */
  private handlePartialSell(pnlSol: number): void {
    if (pnlSol >= 0) {
      this.risk.recordWin(pnlSol);
    } else {
      this.risk.recordLoss(pnlSol);
    }
  }

  /** Feed realized PnL back into the risk manager and notify the operator. */
  private handlePositionClosed(pos: Position): void {
    const pnl = pos.realisedPnlSol ?? 0;
    if (pnl >= 0) {
      this.risk.recordWin(pnl);
    } else {
      this.risk.recordLoss(pnl);
    }

    // Block this specific token from being re-entered for 2 hours
    this.recentlyTraded.set(pos.tokenAddress, Date.now());
    this.saveRecentlyTraded();

    // Block the entire theme cohort after any trade. Prevents buying PVP
    // siblings (which are often honeypots) after closing a position.
    // Negative outcomes get a longer block (30 min), positive ones shorter (10 min).
    const NEGATIVE_REASONS = new Set(['stop_loss', 'rug_signal', 'bundler_detected', 'sell_stuck']);
    const isNegative = NEGATIVE_REASONS.has(pos.closeReason ?? '') || (pos.closeReason === 'timeout' && pnl < 0);
    if (pos.themeKey) {
      const durationMs = isNegative ? undefined : 10 * 60 * 1000; // 10 min for TP, default 30 min for loss
      this.discovery.blockCohort(pos.themeKey, durationMs);
      logger.info('Cohort blocked after close', {
        symbol: pos.tokenSymbol,
        themeKey: pos.themeKey,
        reason: pos.closeReason,
        pnl: pnl.toFixed(4),
        negative: isNegative,
        durationMs: durationMs ?? 30 * 60 * 1000,
      });
    }

    void this.telegram.notifyPositionClosed(pos);
  }

  /** Periodically check prices of open dry run signals for virtual PnL tracking */
  private startDryRunPriceMonitor(): void {
    if (!configManager.isDryRun()) return;

    // Guards against a slow check (GMGN paces each request ~2.5s, so many open
    // signals can take longer than the 30s tick) overlapping the next one and
    // hammering the API with concurrent fetches.
    let checkRunning = false;

    const check = async () => {
      if (checkRunning) {
        logger.debug('[DRY RUN] Price check still running, skipping tick');
        return;
      }
      checkRunning = true;
      try {
        // Always update SOL price — even when no positions are open.
        // TokenFilter needs live SOL price for liquidity calculations.
        const solUsd = await this.solUsdPrice();
        configManager.setSolPriceUsd(solUsd);

        const open = this.dryRunLogger.getOpenSignals();
        if (open.length === 0) return;

        // GMGN prices are USD; convert to SOL per whole token (tokenUSD / solUSD)
        // so dry-run PnL is SOL-denominated, matching the live path.
        const priceMap = new Map<string, number>();
        const metaMap = new Map<string, { marketCap?: number; volume24h?: number }>();
        for (const signal of open) {
          try {
            const info = await this.discovery.client.fetchTokenInfo(signal.address);
            if (info?.price && info.price > 0 && solUsd > 0) {
              priceMap.set(signal.address, info.price / solUsd);
            }
            if (info?.marketCap || info?.volume24h) {
              metaMap.set(signal.address, {
                marketCap: info.marketCap,
                volume24h: info.volume24h,
              });
            }
          } catch { /* skip this token, keep checking the rest */ }
        }

        // Always run updatePrices — even with an empty price map it advances
        // timeouts and force-closes bad-data (entryPrice/entryTime <= 0) signals.
        const { tpHits, slHits } = this.dryRunLogger.updatePrices(priceMap, metaMap);
        for (const tp of tpHits) {
          await this.safeNotify(`🟢 *[DRY RUN] TP HIT* — ${tp.symbol}\nPnL: +${(tp.virtualPnlPct ?? 0).toFixed(1)}%\nEntry: ◎${tp.entryPrice}\nExit: ◎${tp.currentPrice}`);
        }
        for (const sl of slHits) {
          await this.safeNotify(`🔴 *[DRY RUN] SL HIT* — ${sl.symbol}\nPnL: ${(sl.virtualPnlPct ?? 0).toFixed(1)}%\nEntry: ◎${sl.entryPrice}\nExit: ◎${sl.currentPrice}`);
        }
      } finally {
        checkRunning = false;
      }
    };

    // Run every 5s (SOL price + position prices)
    setInterval(() => { void check().catch((err) => logger.error('[DRY RUN] Price check failed', { err: String(err) })); }, 5_000);
    // First check after 5s
    setTimeout(() => { void check().catch((err) => logger.error('[DRY RUN] Price check failed', { err: String(err) })); }, 5_000);
    logger.info('[DRY RUN] Price monitor started (5s interval)');
  }

  /**
   * Live SOL/USD price for USD→SOL conversions. Tries Jupiter first, then
   * CoinGecko (accessible from Indonesian ISPs). Uses last-known good price
   * as fallback — NEVER falls back to the static $150 which causes false -55%
   * PnL when CoinGecko is rate-limited.
   */
  private lastSolPriceFetchAt: number = 0;
  private lastKnownSolPrice: number = this.loadCachedSolPrice();
  private static readonly SOL_PRICE_CACHE_TTL_MS = 300_000; // 5 min — SOL price doesn't move much

  private static readonly SOL_PRICE_CACHE = path.join(__dirname, '..', 'data', 'sol-price-cache.json');

  private loadCachedSolPrice(): number {
    try {
      const raw = fs.readFileSync(SniperBot.SOL_PRICE_CACHE, 'utf-8');
      const { price, ts } = JSON.parse(raw) as { price: number; ts: number };
      if (price > 0 && Date.now() - ts < 86_400_000) {
        logger.info('SOL price: loaded from cache', { price });
        this.lastSolPriceFetchAt = ts;
        return price;
      }
    } catch { /* no cache or corrupt */ }
    return 0;
  }

  private saveCachedSolPrice(price: number): void {
    try {
      const dir = path.dirname(SniperBot.SOL_PRICE_CACHE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SniperBot.SOL_PRICE_CACHE, JSON.stringify({ price, ts: Date.now() }));
    } catch { /* non-critical */ }
  }

  private async solUsdPrice(): Promise<number> {
    // Use cached price if still fresh (5 min TTL)
    if (this.lastKnownSolPrice > 0 && Date.now() - this.lastSolPriceFetchAt < SniperBot.SOL_PRICE_CACHE_TTL_MS) {
      return this.lastKnownSolPrice;
    }

    // Source 1: Jupiter Price API
    const jup = await this.jupiter.getSolUsdPrice();
    if (jup) {
      this.lastKnownSolPrice = jup;
      this.lastSolPriceFetchAt = Date.now();
      this.saveCachedSolPrice(jup);
      return jup;
    }

    // Source 2: CoinGecko (free, works from Indonesia, but rate-limits)
    try {
      const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as { solana?: { usd?: number } };
        const price = data?.solana?.usd;
        if (price && price > 0) {
          this.lastKnownSolPrice = price;
          this.lastSolPriceFetchAt = Date.now();
          this.saveCachedSolPrice(price);
          return price;
        }
      }
    } catch { /* ignore */ }

    // Source 3: Coinpaprika (free, no key, no rate-limit on ticker)
    try {
      const resp = await fetch('https://api.coinpaprika.com/v1/tickers/sol-solana', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as { quotes?: { USD?: { price?: number } } };
        const price = data?.quotes?.USD?.price;
        if (price && price > 0) {
          this.lastKnownSolPrice = price;
          this.lastSolPriceFetchAt = Date.now();
          this.saveCachedSolPrice(price);
          return price;
        }
      }
    } catch { /* ignore */ }

    // Last-known good price — never use static $150
    if (this.lastKnownSolPrice > 0) {
      logger.debug('SOL price: using last-known', { price: this.lastKnownSolPrice });
      return this.lastKnownSolPrice;
    }

    // Absolute last resort: static fallback (only on cold start before any API call succeeds)
    logger.warn('SOL price: no last-known, falling back to static', { price: SCREENING.solPriceUsd });
    return SCREENING.solPriceUsd;
  }

  /** Telegram notify that never throws — a failed send can't break a sweep. */
  private async safeNotify(msg: string): Promise<void> {
    try {
      await this.telegram.notify(msg);
    } catch (err) {
      logger.warn('Telegram notify failed', { err: String(err) });
    }
  }

  private registerShutdownHooks(): void {
    const shutdown = (signal: string) => {
      // Keep event loop alive with a safety timer so async notify completes
      const keepAlive = setInterval(() => {}, 60_000);
      this.shutdown(signal).finally(() => clearInterval(keepAlive));
      // Force exit after 5s if shutdown hangs
      setTimeout(() => { process.exit(1); }, 5000).unref();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { err: String(err) });
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: String(reason) });
    });
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully`);

    this.discovery.stop();
    this.positions.stop();

    // Synchronous Telegram notify — blocks until HTTP completes, guaranteed delivery.
    // Cannot use async fetch/Grammy because Node.js may exit before they resolve.
    try {
      const { execSync } = await import('child_process');
      const token = ENV.telegramBotToken;
      const chatId = ENV.telegramChatId;
      const text = encodeURIComponent('🛑 Bot shutting down. Open positions are no longer monitored.');
      execSync(
        `curl -s -m 5 -X POST "https://api.telegram.org/bot${token}/sendMessage" -d "chat_id=${chatId}&text=${text}" >/dev/null 2>&1`,
        { timeout: 6000, stdio: 'ignore' },
      );
      logger.info('Shutdown notification sent');
    } catch (err) {
      logger.warn('Shutdown notify failed', { err: String(err) });
    }

    try {
      await this.telegram.stop();
    } catch (err) {
      logger.warn('Error stopping telegram', { err: String(err) });
    }

    logger.info('Shutdown complete');
    process.exit(0);
  }

  private banner(): void {
    const cfg = configManager.get();
    const main = cfg.main;
    const strat = cfg.strategy;
    const lines = [
      '╔══════════════════════════════════════════════╗',
      '║          GMGN SOLANA SNIPER BOT                ║',
      '╠══════════════════════════════════════════════╣',
      `║  Mode:      ${(IS_PRODUCTION ? 'PRODUCTION' : 'TEST').padEnd(33)}║`,
      `║  Env:       ${ENV.nodeEnv.padEnd(33)}║`,
      `║  RPC:       ${truncate(ENV.rpcEndpoint, 33).padEnd(33)}║`,
      `║  Trade:     ${`${main.tradeAmountSol} SOL`.padEnd(33)}║`,
      `║  TP / SL:   ${`+${strat.takeProfitPct}% (sell ${strat.firstTargetSellPct}%) / ${strat.stopLossPct}%`.padEnd(33)}║`,
      `║  Max pos:   ${String(main.maxConcurrentPositions).padEnd(33)}║`,
      '╚══════════════════════════════════════════════╝',
    ];
    for (const line of lines) logger.info(line);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Compact USD formatter: $1.2M / $90K / $420 / N/A (never "$0K"). */
function formatUsd(n: number | undefined): string {
  if (!n || n <= 0) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

/** Format price as full decimal (e.g. 0.000583 instead of 5.83e-4). */
function formatPrice(price: number): string {
  if (price >= 0.01) return price.toFixed(6);
  if (price === 0) return '0';
  const abs = Math.abs(price);
  const decimals = Math.max(6, Math.ceil(-Math.log10(abs)) + 2);
  return price.toFixed(decimals);
}

const bot = new SniperBot();
bot.start().catch((err) => {
  logger.error('Fatal startup error', { err: String(err) });
  process.exit(1);
});
