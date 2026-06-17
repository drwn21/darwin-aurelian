import * as fs from 'fs';
import * as path from 'path';
import { ENV, IS_PRODUCTION, STRATEGY, SCREENING, DRY_RUN } from './config/config.js';
import { TokenInfo, Position } from './types/index.js';
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
import { escapeMarkdown } from './utils/markdown.js';
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

  constructor() {
    this.discovery = new TokenDiscovery(new GmgnClient());
    this.positions = new PositionManager(this.engine, this.history);
    this.telegram = new TelegramBot(this.positions, this.risk, this.history, this.engine, this.dryRunLogger);
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
    this.positions.onAlertHandler((msg) => this.safeNotify(msg));

    // Discovery candidate → screen + (in autonomous mode) trade.
    this.discovery.on('candidate', (token) => {
      this.processChain = this.processChain
        .then(() => this.processCandidate(token))
        .catch((err) => {
          logger.error('Candidate processing failed', { err: String(err) });
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
  private async processCandidate(token: TokenInfo): Promise<void> {
    if (this.shuttingDown) return;
    if (this.telegram.getMode() !== 'autonomous') return;
    if (this.positions.hasPosition(token.address)) return;
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

    const sizeSol = this.risk.getPositionSizeSol();

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
    if (!DRY_RUN) {
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
    logger.info(DRY_RUN ? '[DRY RUN] Would snipe' : 'Sniping candidate', {
      symbol: token.symbol,
      address: token.address,
      score: screen.score,
      sizeSol,
    });

    if (DRY_RUN) {
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

      const ageMin = enriched.createdAt
        ? Math.floor((Date.now() / 1000 - enriched.createdAt) / 60)
        : null;
      const ageStr = ageMin != null
        ? ageMin < 60 ? `${ageMin}min` : `${Math.floor(ageMin / 60)}h`
        : 'N/A';

      const mcapK = formatUsd(enriched.marketCap);
      const volK = formatUsd(enriched.volume24h);
      const priceStr = enriched.price ? `$${enriched.price < 0.01 ? enriched.price.toExponential(2) : enriched.price.toFixed(6)}` : 'N/A';

      // SOL-denominated price and MC
      const solUsd = await this.solUsdPrice();
      configManager.setSolPriceUsd(solUsd);
      const priceSolStr = enriched.price > 0 && solUsd > 0
        ? `◎${(enriched.price / solUsd).toExponential(2)}`
        : 'N/A';
      const mcapSolStr = enriched.marketCap > 0 && solUsd > 0
        ? `◎${(enriched.marketCap / solUsd).toFixed(1)}`
        : 'N/A';

      const buyCnt = enriched.buys ?? '—';
      const sellCnt = enriched.sells ?? '—';
      const bsRatio = enriched.buys && enriched.sells
        ? `${(enriched.buys / enriched.sells).toFixed(1)}x`
        : '—';

      const washStr = enriched.washTrading ? '⚠️ Yes' : '✅ No';
      const bundlerStr = enriched.bundlerRate != null
        ? `${(enriched.bundlerRate * 100).toFixed(1)}%`
        : '—';
      const top10Str = enriched.top10HolderPercent != null
        ? `${(enriched.top10HolderPercent * 100).toFixed(1)}%`
        : '—';
      const devStr = enriched.devTeamHoldRate != null
        ? `${(enriched.devTeamHoldRate * 100).toFixed(1)}%`
        : '—';

      const scoreItems: string[] = [];
      if (enriched.holderCount) scoreItems.push(`• ${enriched.holderCount} holders`);
      if (enriched.volume24h) scoreItems.push(`• ${formatUsd(enriched.volume24h)} vol`);
      if (bsRatio !== '—') scoreItems.push(`• B/S ${bsRatio}`);
      scoreItems.push(`• top10 ${top10Str}`);
      if (enriched.mintAuthRevoked) scoreItems.push('• renounced');

      const msg =
        `🔍 *DRY RUN — Signal Detected*\n\n` +
        `*${enriched.symbol.replace(/[*_\[\]()~`>#+=|{}.!\\-]/g, '')}*\n` +
       `\`${enriched.address}\`\n\n` +
        `💰 Price: ${priceStr} (${priceSolStr})\n\n` +
        `📊 MC: ${mcapK} / ${mcapSolStr}\n` +
        `📈 Volume: ${volK}\n` +
        `👥 Holders: ${enriched.holderCount ?? '—'}\n` +
        `⏳ Age: ${ageStr}\n` +
        `🛒 Buys/Sells: ${buyCnt}/${sellCnt}\n\n` +
        `⭐ Score: ${screen.score}/100\n` +
        scoreItems.join('\n') + '\n\n' +
        `🛡️ Safety\n` +
        `Wash Trading: ${washStr}\n` +
        `Bundler: ${bundlerStr}\n` +
        `Top 10 Holders: ${top10Str}\n` +
        `Dev Holding: ${devStr}\n\n` +
        `🔗 [GMGN](https://gmgn.ai/sol/token/${enriched.address})`;

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
        ageMinutes: ageMin ?? 0,
        buysSells: `${buyCnt}/${sellCnt}`,
        score: screen.score,
        scoreBreakdown: scoreItems,
        washTrading: enriched.washTrading ?? false,
        bundlerPct: enriched.bundlerRate != null ? enriched.bundlerRate * 100 : 0,
        top10Pct: enriched.top10HolderPercent != null ? enriched.top10HolderPercent * 100 : 0,
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
    );

    this.markNotified(token.address);
    await this.telegram.notify(
      `🎯 *Position opened*\n` +
        `Token: ${escapeMarkdown(token.symbol)}\n` +
        `Size: ${sizeSol.toFixed(4)} SOL\n` +
        `Entry: ◎${entryPriceSol.toPrecision(4)}/token\n` +
        `TP/SL: +${STRATEGY.takeProfitPct}% (sell ${STRATEGY.firstTargetSellPct}%, trail ${STRATEGY.trailingStopPct}%) / ${STRATEGY.stopLossPct}% (hard ${STRATEGY.hardStopLossPct}%)\n` +
        `Tx: \`${result.txSig}\``,
    );
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

  /** Feed realized PnL back into the risk manager and notify the operator. */
  private handlePositionClosed(pos: Position): void {
    const pnl = pos.realisedPnlSol ?? 0;
    if (pnl >= 0) {
      this.risk.recordWin(pnl);
    } else {
      this.risk.recordLoss(pnl);
    }

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
    if (!DRY_RUN) return;

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

const bot = new SniperBot();
bot.start().catch((err) => {
  logger.error('Fatal startup error', { err: String(err) });
  process.exit(1);
});
