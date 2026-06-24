import { TokenInfo, FilterResult } from '../types/index.js';
import { SCREENING } from '../config/config.js';
import { configManager } from '../config/ConfigManager.js';
import { logger } from '../logger/Logger.js';

/**
 * Tunable screening thresholds. Anything omitted falls back to the SCREENING
 * config block, so `new TokenFilter()` reproduces the configured defaults while
 * callers (tests, the Telegram UI, future strategies) can override per-instance.
 */
export interface TokenFilterOptions {
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  /** Minimum liquidity, denominated in SOL and converted via `solPriceUsd`. */
  minLiquiditySol?: number;
  /** SOL→USD reference price for the SOL-denominated liquidity floor. */
  solPriceUsd?: number;
  minVolume1hUsd?: number;
  minAgeMs?: number;
  maxAgeMs?: number;
  minHolderCount?: number;
  maxTop10HolderPctReject?: number;
  minBuySellRatio?: number;
  rejectMintAuthorityActive?: boolean;
  rejectFreezeAuthorityActive?: boolean;
  minLpBurnedOrLockedPct?: number;
  rejectDevHoldingPct?: number;
  /** 1h-vs-24h-hourly-average ratio that earns full volume-spike points. */
  minVolumeSpikeRatio?: number;
  /** Soft gate: composite score (0–100) a token must also clear to pass. */
  minCompositeScore?: number;
  /** Minimum 24h volume in USD. */
  minVolume24hUsd?: number;
  /** Maximum bundler rate (0-1). Reject tokens with high bundler activity. */
  maxBundlerRate?: number;
  /** Maximum entrapment ratio (0-1). Reject tokens with high entrapment. */
  maxEntrapmentRatio?: number;
  /** Minimum 5m price change (%). Reject tokens dumping too hard. */
  minPriceChange5mPct?: number;
  /** Maximum 5m price change (%). Reject tokens pumping too hard. */
  maxPriceChange5mPct?: number;
  /** Maximum 1h price change (%). Reject tokens with extreme 1h pump. */
  maxPriceChange1hPct?: number;
  /** Minimum 1h price change (%). Reject tokens already dumping. */
  minPriceChange1hPct?: number;
  /** Minimum 1m price change (%). Reject tokens with sudden 1m dumps. */
  minPriceChange1mPct?: number;
  /** Maximum 1m price change (%). Reject tokens with suspicious 1m spikes. */
  maxPriceChange1mPct?: number;
  /** Minimum smart degen wallet count. Reject tokens with no smart money interest. */
  minSmartDegenCount?: number;
}

type ResolvedOptions = Required<TokenFilterOptions>;

/** Breakdown of the composite score, exposed for logging/debugging. */
export interface ScoreBreakdown {
  liquidity: number;
  marketCap: number;
  holders: number;
  distribution: number;
  momentum: number;
  volumeSpike: number;
  total: number;
  /** 1h volume / (24h volume / 24); 1 = on-trend, >1 = spiking. */
  volumeSpikeRatio: number;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Applies all configured screening criteria to a candidate token.
 *
 * Hard criteria (mcap, liquidity, age, authorities, …) produce human-readable
 * rejection reasons. Independently, a composite 0–100 score grades how
 * attractive a *passing* candidate is; tokens below `minCompositeScore` are
 * rejected even if every hard criterion is met. Every decision is logged.
 */
export class TokenFilter {
  private readonly overrides: TokenFilterOptions;
  /** Track recent priceChange5m readings per token for deceleration detection. */
  private readonly priceHistory = new Map<string, number[]>();
  private static readonly MAX_HISTORY = 3;

  constructor(options: TokenFilterOptions = {}) {
    this.overrides = options;
  }

  /**
   * Record a 5m price change reading for a token. Returns true if the token
   * shows consistent deceleration (each reading lower than previous by >10%).
   */
  checkPriceDeceleration(address: string, priceChange5m: number): boolean {
    const history = this.priceHistory.get(address) ?? [];
    history.push(priceChange5m);
    if (history.length > TokenFilter.MAX_HISTORY) {
      history.shift(); // keep only last 3
    }
    this.priceHistory.set(address, history);

    // Need at least 3 readings to detect a trend
    if (history.length < 3) return false;

    // Check for consistent deceleration: each reading lower than previous by >10%
    for (let i = 1; i < history.length; i++) {
      if (history[i] >= history[i - 1] - 10) return false;
    }
    return true;
  }

  /** Clear price history for a token (call when token is no longer a candidate). */
  clearPriceHistory(address: string): void {
    this.priceHistory.delete(address);
  }

  /** Prune history for tokens not seen recently. */
  prunePriceHistory(activeAddresses: Set<string>): void {
    for (const addr of this.priceHistory.keys()) {
      if (!activeAddresses.has(addr)) {
        this.priceHistory.delete(addr);
      }
    }
  }

  /**
   * Resolve the effective thresholds at the point of use. Precedence:
   * explicit constructor override > live `configManager` value (the Telegram
   * /config panel) > static `SCREENING` default. Only the fields the runtime
   * config actually owns (mcap, holders, age, composite score) are live-tunable;
   * the rest fall back to the static defaults. Resolving on every call is what
   * makes a /config edit take effect on the next screening cycle without a
   * restart.
   */
  private resolve(): ResolvedOptions {
    const o = this.overrides;
    const live = configManager.get().screening;
    return {
      minMarketCapUsd: o.minMarketCapUsd ?? live.minMarketCapUsd ?? SCREENING.minMarketCapUsd,
      maxMarketCapUsd: o.maxMarketCapUsd ?? live.maxMarketCapUsd ?? SCREENING.maxMarketCapUsd,
      minLiquiditySol: o.minLiquiditySol ?? SCREENING.minLiquiditySol,
      solPriceUsd: o.solPriceUsd ?? (configManager.solPriceUsd > 0 ? configManager.solPriceUsd : SCREENING.solPriceUsd),
      minVolume1hUsd: o.minVolume1hUsd ?? SCREENING.minVolume1hUsd,
      minAgeMs: o.minAgeMs ?? SCREENING.minAgeMs,
      maxAgeMs: o.maxAgeMs ?? live.maxAgeMs ?? SCREENING.maxAgeMs,
      minHolderCount: o.minHolderCount ?? live.minHolderCount ?? SCREENING.minHolderCount,
      maxTop10HolderPctReject: o.maxTop10HolderPctReject ?? SCREENING.maxTop10HolderPctReject,
      minBuySellRatio: o.minBuySellRatio ?? SCREENING.minBuySellRatio,
      rejectMintAuthorityActive: o.rejectMintAuthorityActive ?? SCREENING.rejectMintAuthorityActive,
      rejectFreezeAuthorityActive: o.rejectFreezeAuthorityActive ?? SCREENING.rejectFreezeAuthorityActive,
      minLpBurnedOrLockedPct: o.minLpBurnedOrLockedPct ?? SCREENING.minLpBurnedOrLockedPct,
      rejectDevHoldingPct: o.rejectDevHoldingPct ?? SCREENING.rejectDevHoldingPct,
      minVolumeSpikeRatio: o.minVolumeSpikeRatio ?? SCREENING.minVolumeSpikeRatio,
      minCompositeScore: o.minCompositeScore ?? live.minCompositeScore ?? SCREENING.minCompositeScore,
      minVolume24hUsd: o.minVolume24hUsd ?? live.minVolume24hUsd ?? 0,
      maxBundlerRate: o.maxBundlerRate ?? live.maxBundlerRate ?? 1,
      maxEntrapmentRatio: o.maxEntrapmentRatio ?? live.maxEntrapmentRatio ?? 1,
      minPriceChange5mPct: o.minPriceChange5mPct ?? live.minPriceChange5mPct ?? -100,
      maxPriceChange5mPct: o.maxPriceChange5mPct ?? live.maxPriceChange5mPct ?? 999,
      maxPriceChange1hPct: o.maxPriceChange1hPct ?? live.maxPriceChange1hPct ?? 999,
      minPriceChange1hPct: o.minPriceChange1hPct ?? live.minPriceChange1hPct ?? -999,
      minPriceChange1mPct: o.minPriceChange1mPct ?? live.minPriceChange1mPct ?? -100,
      maxPriceChange1mPct: o.maxPriceChange1mPct ?? live.maxPriceChange1mPct ?? 999,
      minSmartDegenCount: o.minSmartDegenCount ?? live.minSmartDegenCount ?? 0,
    };
  }

  /**
   * Effective USD liquidity floor. Prefers the live `configManager`
   * `minLiquidityUsd` (USD-denominated, set via /config) unless a caller
   * explicitly passed a SOL-denominated override, in which case the
   * SOL→USD computation wins.
   */
  private liquidityFloorUsd(o: ResolvedOptions): number {
    const overrode = this.overrides.minLiquiditySol !== undefined ||
      this.overrides.solPriceUsd !== undefined;
    if (!overrode) {
      const liveUsd = configManager.get().screening.minLiquidityUsd;
      if (typeof liveUsd === 'number' && liveUsd > 0) return liveUsd;
    }
    return o.minLiquiditySol * o.solPriceUsd;
  }

  filter(token: TokenInfo): FilterResult {
    let result: FilterResult;
    try {
      result = this.evaluate(token);
    } catch (err) {
      // Never let a malformed candidate crash the discovery loop — reject it.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('TokenFilter: evaluation error, rejecting', {
        token: token?.address,
        err: message,
      });
      return { passed: false, reasons: [`evaluation error: ${message}`], score: 0 };
    }

    if (result.passed) {
      logger.info('TokenFilter: ACCEPT', {
        symbol: token.symbol,
        address: token.address,
        score: result.score,
      });
    } else {
      logger.info('TokenFilter: REJECT', {
        symbol: token.symbol,
        address: token.address,
        score: result.score,
        reasons: result.reasons,
      });
    }
    return result;
  }

  private evaluate(token: TokenInfo): FilterResult {
    const o = this.resolve();
    const minLiquidityUsd = this.liquidityFloorUsd(o);
    const reasons: string[] = [];

    // ── Market cap range ──────────────────────────────────────────────────
    if (token.marketCap < o.minMarketCapUsd) {
      reasons.push(`mcap $${fmt(token.marketCap)} < min $${fmt(o.minMarketCapUsd)}`);
    }
    if (token.marketCap > o.maxMarketCapUsd) {
      reasons.push(`mcap $${fmt(token.marketCap)} > max $${fmt(o.maxMarketCapUsd)}`);
    }

    // ── Liquidity ─────────────────────────────────────────────────────────
    if (token.liquidity < minLiquidityUsd) {
      reasons.push(
        `liquidity $${fmt(token.liquidity)} < min $${fmt(minLiquidityUsd)} ` +
          `(${o.minLiquiditySol} SOL @ $${o.solPriceUsd})`,
      );
    }

    // ── Volume ────────────────────────────────────────────────────────────
    // GMGN rank API doesn't expose volume_1h — skip 1h volume hard filter.
    // Volume spike ratio in scoring will fall back to neutral (1.0).
    // if (token.volume1h < o.minVolume1hUsd) {
    //   reasons.push(`1h vol $${fmt(token.volume1h)} < min $${fmt(o.minVolume1hUsd)}`);
    // }

    // ── Age ───────────────────────────────────────────────────────────────
    const ageMs = token.createdAt > 0 ? Date.now() - token.createdAt * 1000 : 0;
    if (token.createdAt <= 0) {
      reasons.push('age unknown (createdAt=0)');
    } else {
      if (ageMs < o.minAgeMs) {
        reasons.push(`age ${Math.round(ageMs / 60_000)}m < min ${Math.round(o.minAgeMs / 60_000)}m`);
      }
      if (ageMs > o.maxAgeMs) {
        reasons.push(`age ${Math.round(ageMs / 60_000)}m > max ${Math.round(o.maxAgeMs / 60_000)}m`);
      }
    }

    // ── Holder distribution ───────────────────────────────────────────────
    if (token.holderCount < o.minHolderCount) {
      reasons.push(`holders ${token.holderCount} < min ${o.minHolderCount}`);
    }
    if (token.top10HolderPercent > o.maxTop10HolderPctReject) {
      reasons.push(
        `top10 hold ${token.top10HolderPercent.toFixed(1)}% > max ${o.maxTop10HolderPctReject}%`,
      );
    }

    // ── Momentum ──────────────────────────────────────────────────────────
    // Buy/sell ratio (momentum) — replaces old priceChange5m check
    const buySellRatio = token.buys && token.sells ? token.buys / Math.max(token.sells, 1) : 0;
    if (buySellRatio < o.minBuySellRatio) {
      reasons.push(`buy/sell ratio ${buySellRatio.toFixed(2)} < min ${o.minBuySellRatio}`);
    }

    // ── Rug protection ────────────────────────────────────────────────────
    // NOTE: mint/freeze authority gating intentionally lives in RugChecker,
    // which verifies them on-chain after this filter passes. GMGN's renounce
    // flags are stale (always 0) for fresh Pump.fun tokens, so checking them
    // here would wrongly reject every Pump.fun candidate. LP-burn is also
    // disabled here because Pump.fun bonding-curve tokens always show 0% burn
    // on GMGN — RugChecker still penalises low LP burn in its risk score.
    // if (token.lpBurnedPercent < o.minLpBurnedOrLockedPct) {
    //   reasons.push(`LP burned ${token.lpBurnedPercent}% < min ${o.minLpBurnedOrLockedPct}%`);
    // }
    if (token.devHoldingPercent > o.rejectDevHoldingPct) {
      reasons.push(`dev holds ${token.devHoldingPercent.toFixed(1)}% > max ${o.rejectDevHoldingPct}%`);
    }

    // ── Volume floor ────────────────────────────────────────────────────
    if (o.minVolume24hUsd > 0 && token.volume24h < o.minVolume24hUsd) {
      reasons.push(`24h vol $${fmt(token.volume24h)} < min $${fmt(o.minVolume24hUsd)}`);
    }

    // ── Bundler rate cap ────────────────────────────────────────────────
    const bundlerRate = token.bundlerRate ?? 0;
    if (o.maxBundlerRate < 1 && bundlerRate > o.maxBundlerRate) {
      reasons.push(`bundler ${(bundlerRate * 100).toFixed(0)}% > max ${(o.maxBundlerRate * 100).toFixed(0)}%`);
    }

    // ── Entrapment cap ──────────────────────────────────────────────────
    const entrapment = token.entrapmentRatio ?? 0;
    if (o.maxEntrapmentRatio < 1 && entrapment > o.maxEntrapmentRatio) {
      reasons.push(`entrapment ${(entrapment * 100).toFixed(0)}% > max ${(o.maxEntrapmentRatio * 100).toFixed(0)}%`);
    }

    // ── 5m price change range ───────────────────────────────────────────
    if (o.minPriceChange5mPct > -100 && token.priceChange5m < o.minPriceChange5mPct) {
      reasons.push(`5m change ${token.priceChange5m.toFixed(1)}% < min ${o.minPriceChange5mPct}%`);
    }
    if (o.maxPriceChange5mPct < 999 && token.priceChange5m > o.maxPriceChange5mPct) {
      reasons.push(`5m change ${token.priceChange5m.toFixed(1)}% > max ${o.maxPriceChange5mPct}%`);
    }

    // ── 1h price change range ───────────────────────────────────────────
    if (o.minPriceChange1hPct > -999 && token.priceChange1h < o.minPriceChange1hPct) {
      reasons.push(`1h change ${token.priceChange1h.toFixed(1)}% < min ${o.minPriceChange1hPct}%`);
    }
    if (o.maxPriceChange1hPct < 999 && token.priceChange1h > o.maxPriceChange1hPct) {
      reasons.push(`1h change ${token.priceChange1h.toFixed(1)}% > max ${o.maxPriceChange1hPct}%`);
    }

    // ── 1m price change range ──────────────────────────────────────────
    if (o.minPriceChange1mPct > -100 && token.priceChange1m < o.minPriceChange1mPct) {
      reasons.push(`1m change ${token.priceChange1m.toFixed(1)}% < min ${o.minPriceChange1mPct}%`);
    }
    if (o.maxPriceChange1mPct < 999 && token.priceChange1m > o.maxPriceChange1mPct) {
      reasons.push(`1m change ${token.priceChange1m.toFixed(1)}% > max ${o.maxPriceChange1mPct}%`);
    }

    // ── Smart money gate ──────────────────────────────────────────────
    const smartDegen = token.smartDegenCount ?? 0;
    if (o.minSmartDegenCount > 0 && smartDegen < o.minSmartDegenCount) {
      reasons.push(`smart degens ${smartDegen} < min ${o.minSmartDegenCount}`);
    }

    // ── Price deceleration check (5m trend) ────────────────────────────
    if (this.checkPriceDeceleration(token.address, token.priceChange5m)) {
      reasons.push(`5m price decelerating: ${token.priceChange5m.toFixed(1)}% (consistent downtrend)`);
    }

    // ── Composite score (soft gate) ───────────────────────────────────────
    const breakdown = this.score(token);
    if (breakdown.total < o.minCompositeScore) {
      reasons.push(`composite score ${breakdown.total} < min ${o.minCompositeScore}`);
    }

    return { passed: reasons.length === 0, reasons, score: breakdown.total };
  }

  /**
   * Volume-spike ratio: 24h volume relative to market cap as an activity proxy.
   *
   * M5: the previous implementation used priceChange5m as the proxy, which the
   * momentum component already scores — double-counting recent price action.
   * The volume/mcap ratio is an independent activity signal: >0.1 means the
   * token is turning over a meaningful fraction of its cap (high activity),
   * >0.5 is hot. Returns a ratio normalised around the same 0.5/1.0/1.5 bands
   * the score() weighting expects.
   */
  private volumeSpikeRatio(token: TokenInfo): number {
    const mcap = token.marketCap ?? 0;
    const vol = token.volume24h ?? 0;
    if (!(mcap > 0) || !(vol > 0)) return 0.5; // unknown → neutral-low
    const ratio = vol / mcap;
    if (ratio > 0.5) return 1.5;
    if (ratio > 0.1) return 1.0;
    return 0.5;
  }

  /**
   * Composite 0–100 attractiveness score. Six independent components, each
   * capped so the maximum is exactly 100:
   *   liquidity 20 · marketCap 15 · holders 15 · distribution 15 ·
   *   momentum 15 · volumeSpike 20
   */
  score(token: TokenInfo): ScoreBreakdown {
    const o = this.resolve();
    const minLiquidityUsd = this.liquidityFloorUsd(o);

    // Liquidity: full marks at 5× the configured floor.
    const liquidity = clamp((token.liquidity / (minLiquidityUsd * 5)) * 20, 0, 20);

    // Market cap: tent function peaking at the geometric midpoint of the range,
    // rewarding the "not too small, not too frothy" middle of the band.
    const marketCap = this.marketCapScore(token.marketCap, o) * 15;

    // Holders: full marks at 4× the minimum holder count.
    const holders = clamp((token.holderCount / (o.minHolderCount * 4)) * 15, 0, 15);

    // Distribution: less top-10 concentration is better (0% → 15, 100% → 0).
    const distribution = clamp((1 - token.top10HolderPercent / 100) * 15, 0, 15);

    // Momentum: full marks at +30% over the last 5m; negative penalizes score.
    const momentum = token.priceChange5m >= 0
      ? clamp((token.priceChange5m / 30) * 15, 0, 15)
      : clamp((token.priceChange5m / 10) * 5, -5, 0);

    // Volume spike: full marks once the spike ratio reaches the threshold.
    const volumeSpikeRatio = this.volumeSpikeRatio(token);
    const volumeSpike = clamp((volumeSpikeRatio / o.minVolumeSpikeRatio) * 20, 0, 20);

    // Additional GMGN pre-pump quality signals, layered on top of the six core
    // components without altering their weights. Clamped to keep score in 0–100.
    const extra = this.extraSignalScore(token);

    const total = clamp(
      Math.round(liquidity + marketCap + holders + distribution + momentum + volumeSpike + extra),
      0,
      100,
    );

    return {
      liquidity: round1(liquidity),
      marketCap: round1(marketCap),
      holders: round1(holders),
      distribution: round1(distribution),
      momentum: round1(momentum),
      volumeSpike: round1(volumeSpike),
      total,
      volumeSpikeRatio: round1(volumeSpikeRatio),
    };
  }

  /**
   * Additional GMGN pre-pump quality signals, layered additively on top of the
   * six core score components (can be negative). Does NOT change the existing
   * component weights. Missing GMGN fields fall back to the neutral 0.
   */
  private extraSignalScore(token: TokenInfo): number {
    let extra = 0;

    // Entrapment ratio: reward genuinely low entrapment, penalise elevated.
    const entrapment = token.entrapmentRatio ?? 0;
    if (entrapment < 0.03) extra += 3;
    else if (entrapment > 0.08) extra -= 5;

    // Smart-money ("smart degen") wallets buying the token.
    const smartDegen = token.smartDegenCount ?? 0;
    if (smartDegen >= 2) extra += 5;
    else if (smartDegen >= 1) extra += 3;

    // Sniper bots: a healthy 10–40 band (early interest, not a full swarm).
    const snipers = token.sniperCount ?? 0;
    if (snipers >= 10 && snipers <= 40) extra += 3;

    // GMGN heat level (0–3).
    if ((token.hotLevel ?? 0) >= 2) extra += 3;

    return extra;
  }

  /** Returns 0–1: 1 at the geometric midpoint of [min,max], 0 at/outside edges. */
  private marketCapScore(mcap: number, o: ResolvedOptions): number {
    const { minMarketCapUsd: lo, maxMarketCapUsd: hi } = o;
    if (mcap <= lo || mcap >= hi) return 0;
    const mid = Math.sqrt(lo * hi);
    if (mcap <= mid) {
      return (mcap - lo) / (mid - lo);
    }
    return (hi - mcap) / (hi - mid);
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
