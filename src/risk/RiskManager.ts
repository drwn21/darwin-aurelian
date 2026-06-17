import { RiskState, CanTradeResult } from '../types/index.js';
import { RISK } from '../config/config.js';
import { configManager } from '../config/ConfigManager.js';
import { logger } from '../logger/Logger.js';

/**
 * Per-instance overrides for the risk controls. Anything omitted falls back to
 * the RISK config block, so `new RiskManager()` reproduces the configured
 * defaults.
 */
export interface RiskManagerOptions {
  /** Day's starting wallet balance (SOL); anchors the % daily-loss limit. */
  startingBalanceSol?: number;
  perTradeSizeSol?: number;
  maxPerTradeSizeSol?: number;
  maxConcurrentPositions?: number;
  /** Daily loss limit as a % of the starting balance. */
  dailyLossLimitPct?: number;
  /** Absolute daily loss limit (SOL); used when no starting balance is known. */
  dailyLossLimitSol?: number;
  maxConsecutiveLosses?: number;
  cooldownAfterLossMs?: number;
}

type ResolvedOptions = Required<Omit<RiskManagerOptions, 'startingBalanceSol'>>;

/**
 * Central gatekeeper for opening trades. Enforces concurrency, per-trade size,
 * a daily loss limit (preferring a % of the starting balance), and a cooldown
 * after a run of consecutive losses. Tracks daily PnL and resets at midnight.
 */
export class RiskManager {
  private state: RiskState;
  private readonly overrides: RiskManagerOptions;

  constructor(options: RiskManagerOptions = {}) {
    this.overrides = options;

    this.state = {
      dailyPnlSol: 0,
      tradesOpenCount: 0,
      consecutiveLosses: 0,
      dailyResetAt: this.nextMidnight(),
      startingBalanceSol: Math.max(0, options.startingBalanceSol ?? 0),
    };
  }

  /**
   * Resolve the effective risk controls at the point of use. Precedence:
   * explicit constructor override > live `configManager` value (the Telegram
   * /config panel) > static `RISK` default. Resolving on every call is what
   * lets a /config edit to sizing / loss limits / cooldown take effect on the
   * next trade without a restart. `dailyLossLimitPct` is not exposed in the
   * runtime config, so it always comes from the override or the static default.
   */
  private resolve(): ResolvedOptions {
    const o = this.overrides;
    const cfg = configManager.get();
    return {
      perTradeSizeSol: o.perTradeSizeSol ?? cfg.main.tradeAmountSol ?? RISK.perTradeSizeSol,
      maxPerTradeSizeSol: o.maxPerTradeSizeSol ?? cfg.risk.maxPerTradeSol ?? RISK.maxPerTradeSizeSol,
      maxConcurrentPositions:
        o.maxConcurrentPositions ?? cfg.main.maxConcurrentPositions ?? RISK.maxConcurrentPositions,
      dailyLossLimitPct: o.dailyLossLimitPct ?? RISK.dailyLossLimitPct,
      dailyLossLimitSol: o.dailyLossLimitSol ?? cfg.risk.dailyLossLimitSol ?? RISK.dailyLossLimitSol,
      maxConsecutiveLosses:
        o.maxConsecutiveLosses ?? cfg.risk.maxConsecutiveLosses ?? RISK.maxConsecutiveLosses,
      cooldownAfterLossMs: o.cooldownAfterLossMs ?? cfg.risk.cooldownMs ?? RISK.cooldownAfterLossMs,
    };
  }

  /**
   * Refresh the balance used to anchor the % daily-loss limit. Call this once
   * the live wallet balance is known (and ideally at each daily reset).
   */
  setStartingBalance(balanceSol: number): void {
    this.state.startingBalanceSol = Math.max(0, balanceSol);
    logger.info('Risk: starting balance set', {
      startingBalanceSol: this.state.startingBalanceSol.toFixed(4),
      dailyLossLimitSol: this.effectiveDailyLossLimitSol().toFixed(4),
    });
  }

  /**
   * Checks every precondition for opening a new trade.
   *
   * @param currentOpenCount live count of open positions (source of truth lives
   *   in PositionManager, so it's passed in rather than tracked here).
   * @param requestedSizeSol optional trade size to validate against the
   *   per-trade cap; defaults to the configured per-trade size.
   */
  canTrade(currentOpenCount: number, requestedSizeSol?: number): CanTradeResult {
    this.maybeResetDaily();
    const o = this.resolve();

    if (currentOpenCount >= o.maxConcurrentPositions) {
      return this.deny(`Max concurrent positions (${o.maxConcurrentPositions}) reached`);
    }

    const size = requestedSizeSol ?? this.getPositionSizeSol();
    if (size <= 0) {
      return this.deny(`Invalid trade size (${size} SOL)`);
    }
    if (size > o.maxPerTradeSizeSol) {
      return this.deny(
        `Trade size ${size.toFixed(4)} SOL > per-trade limit ${o.maxPerTradeSizeSol} SOL`,
      );
    }

    const lossLimit = this.effectiveDailyLossLimitSol();
    if (this.state.dailyPnlSol <= -lossLimit) {
      return this.deny(
        `Daily loss limit hit (${this.state.dailyPnlSol.toFixed(4)} / -${lossLimit.toFixed(4)} SOL)`,
      );
    }

    if (this.state.consecutiveLosses >= o.maxConsecutiveLosses) {
      const remaining = this.cooldownRemainingMs();
      if (remaining > 0) {
        return this.deny(
          `Cooldown active: ${Math.ceil(remaining / 60_000)}m remaining after ` +
            `${this.state.consecutiveLosses} consecutive losses`,
        );
      }
    }

    return { allowed: true };
  }

  /**
   * Configured per-trade size in SOL, scaled down after consecutive losses
   * (down to 50%) and clamped to the per-trade ceiling.
   */
  getPositionSizeSol(): number {
    const o = this.resolve();
    const reductionFactor = Math.max(0.5, 1 - this.state.consecutiveLosses * 0.1);
    const size = o.perTradeSizeSol * reductionFactor;
    return Math.min(size, o.maxPerTradeSizeSol);
  }

  recordWin(pnlSol: number): void {
    this.maybeResetDaily();
    this.state.dailyPnlSol += pnlSol;
    this.state.consecutiveLosses = 0;
    this.state.lastTradeAt = Date.now();
    logger.info('Risk: win recorded', {
      pnlSol: pnlSol.toFixed(4),
      dailyPnl: this.state.dailyPnlSol.toFixed(4),
    });
  }

  recordLoss(pnlSol: number): void {
    this.maybeResetDaily();
    // pnlSol is expected to be <= 0; guard against a positive value being
    // mislabelled as a loss so daily PnL stays accurate.
    this.state.dailyPnlSol += Math.min(0, pnlSol);
    this.state.consecutiveLosses++;
    this.state.lastTradeAt = Date.now();
    logger.warn('Risk: loss recorded', {
      pnlSol: pnlSol.toFixed(4),
      consecutiveLosses: this.state.consecutiveLosses,
      dailyPnl: this.state.dailyPnlSol.toFixed(4),
    });
  }

  getState(): Readonly<RiskState> {
    this.maybeResetDaily();
    return { ...this.state };
  }

  formatStatus(): string {
    const s = this.getState();
    const o = this.resolve();
    const limit = this.effectiveDailyLossLimitSol();
    const cooldownRemaining = this.cooldownRemainingMs();
    const lines = [
      `Daily PnL: ${s.dailyPnlSol >= 0 ? '+' : ''}${s.dailyPnlSol.toFixed(4)} SOL`,
      `Daily loss limit: -${limit.toFixed(4)} SOL` +
        (s.startingBalanceSol > 0
          ? ` (${o.dailyLossLimitPct}% of ${s.startingBalanceSol.toFixed(2)} SOL)`
          : ' (absolute)'),
      `Consecutive losses: ${s.consecutiveLosses}/${o.maxConsecutiveLosses}`,
    ];
    if (cooldownRemaining > 0) {
      lines.push(`Cooldown: ${Math.ceil(cooldownRemaining / 60_000)}m remaining`);
    }
    return lines.join('\n');
  }

  /** Daily loss limit in SOL: % of starting balance, else the absolute floor. */
  private effectiveDailyLossLimitSol(): number {
    const o = this.resolve();
    if (this.state.startingBalanceSol > 0) {
      return (this.state.startingBalanceSol * o.dailyLossLimitPct) / 100;
    }
    return o.dailyLossLimitSol;
  }

  private cooldownRemainingMs(): number {
    const o = this.resolve();
    if (this.state.consecutiveLosses < o.maxConsecutiveLosses) return 0;
    if (!this.state.lastTradeAt) return 0;
    const elapsed = Date.now() - this.state.lastTradeAt;
    return Math.max(0, o.cooldownAfterLossMs - elapsed);
  }

  private maybeResetDaily(): void {
    if (Date.now() >= this.state.dailyResetAt) {
      logger.info('Risk: daily limits reset', {
        previousDailyPnl: this.state.dailyPnlSol.toFixed(4),
      });
      this.state.dailyPnlSol = 0;
      this.state.consecutiveLosses = 0;
      this.state.dailyResetAt = this.nextMidnight();
    }
  }

  private deny(reason: string): CanTradeResult {
    logger.debug('Risk: trade denied', { reason });
    return { allowed: false, reason };
  }

  private nextMidnight(): number {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
}
