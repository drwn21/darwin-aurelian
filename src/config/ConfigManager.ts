import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { ENV, STRATEGY, SCREENING, RISK, DRY_RUN } from './config.js';
import { logger } from '../logger/Logger.js';

/**
 * Runtime-tunable configuration, persisted to `config/runtime.json` and
 * editable live through the Telegram /config panel.
 *
 * This is the single source of truth at runtime: every module reads the live
 * value at the point of use, so a change applied through Telegram takes effect
 * on the next discovery / screening / execution cycle without a restart.
 *
 * The static blocks in `config.ts` (STRATEGY / SCREENING / RISK) are kept as
 * the seed defaults — `runtime.json` is an overlay on top of them.
 */
export interface RuntimeConfig {
  /** 'test' is a label/guard; 'production' marks live-capital trading. */
  mode: 'test' | 'production';
  /** When true, candidates are screened + notified but never bought. */
  dryRun: boolean;

  main: {
    tradeAmountSol: number;
    maxConcurrentPositions: number;
  };

  risk: {
    dailyLossLimitSol: number;
    maxConsecutiveLosses: number;
    /** Cooldown after the consecutive-loss streak trips, in ms. */
    cooldownMs: number;
    maxPerTradeSol: number;
  };

  strategy: {
    buySlippageBps: number;
    sellSlippageBps: number;
    priorityFeeLamports: number;
    /** Force-close a position after this age, in ms. */
    positionTimeoutMs: number;
    /** TP trigger as a % gain (e.g. 50 = +50%) — partial sell. */
    takeProfitPct: number;
    /** % of the position to sell at TP. */
    firstTargetSellPct: number;
    /** Trail drop: close remainder when price drops this % from peak. */
    trailingStopPct: number;
    /** Enable trailing stop after partial sell. */
    useTrailingStop: boolean;
    /** Soft stop-loss as a % loss (e.g. -20) — after grace + confirms. */
    stopLossPct: number;
    /** Hard stop-loss (e.g. -30) — immediate, no grace. */
    hardStopLossPct: number;
    /** Grace period before soft SL arms (ms). */
    slGracePeriodMs: number;
    /** Consecutive checks below soft SL before triggering. */
    slConfirms: number;
    /** Minimum token age (ms) before canSellBack probe runs. Tokens younger
     *  than this skip the Jupiter sell-simulation to avoid false positives on
     *  very new launches that don't have routes yet. */
    canSellBackMinAgeMs: number;
    /** Max number of sell retries before marking a position as stuck. */
    maxSellRetries: number;
    /** Consecutive price-feed misses before force-closing a position. */
    priceFailCloseThreshold: number;
  };

  screening: {
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minLiquidityUsd: number;
    minHolderCount: number;
    /** Maximum token age to snipe, in ms. */
    maxAgeMs: number;
    minCompositeScore: number;
    originality?: {
      minScore: number;
      minMargin: number;
      cohortWindowMs: number;
      singletonDelayMs: number;
    };
  };

  gmgn: {
    /** GMGN candle interval (e.g. '5m'), not the bot's poll cadence. */
    interval: string;
    orderBy: string;
    limit: number;
    /** Pre-filter: drop ranked tokens whose 24h volume is below this (USD). */
    minVolumeUsd: number;
  };

  /** Runtime safety monitors that watch open positions for active rugs. */
  safety: {
    /** Run the active-bundler transfer-burst check on open positions. */
    bundlerCheckEnabled: boolean;
    /** Run the runtime rug-signal check on open positions. */
    rugSignalCheckEnabled: boolean;
    /** Minimum gap between safety checks per position, in ms. */
    bundlerCheckIntervalMs: number;
  };
}

const RUNTIME_FILE = path.join(process.cwd(), 'config', 'runtime.json');

/** Build the seed config from the static defaults + environment. */
function buildDefaults(): RuntimeConfig {
  return {
    mode: ENV.nodeEnv,
    dryRun: DRY_RUN,
    main: {
      tradeAmountSol: STRATEGY.tradeAmountSol,
      maxConcurrentPositions: STRATEGY.maxConcurrentPositions,
    },
    risk: {
      dailyLossLimitSol: STRATEGY.dailyLossLimitSol,
      maxConsecutiveLosses: STRATEGY.maxConsecutiveLosses,
      cooldownMs: RISK.cooldownAfterLossMs,
      maxPerTradeSol: STRATEGY.maxPositionSizeSol,
    },
    strategy: {
      buySlippageBps: STRATEGY.buySlippageBps,
      sellSlippageBps: STRATEGY.sellSlippageBps,
      priorityFeeLamports: STRATEGY.priorityFeeLamports,
      positionTimeoutMs: STRATEGY.positionTimeoutMs,
      takeProfitPct: STRATEGY.takeProfitPct,
      firstTargetSellPct: STRATEGY.firstTargetSellPct,
      trailingStopPct: STRATEGY.trailingStopPct,
      useTrailingStop: STRATEGY.useTrailingStop,
      stopLossPct: STRATEGY.stopLossPct,
      hardStopLossPct: STRATEGY.hardStopLossPct,
      slGracePeriodMs: STRATEGY.slGracePeriodMs,
      slConfirms: STRATEGY.slConfirms,
      canSellBackMinAgeMs: 120 * 60 * 1000,
      maxSellRetries: 10,
      // 10 misses × 5s ≈ 50s of dark feed + 120s grace ≈ 2.5 min before fail-closed.
      // Fast enough to catch LP removal, slow enough for unindexed Pump.fun tokens.
      priceFailCloseThreshold: 10,
    },
    screening: {
      minMarketCapUsd: SCREENING.minMarketCapUsd,
      maxMarketCapUsd: SCREENING.maxMarketCapUsd,
      minLiquidityUsd: SCREENING.minLiquidityUsd,
      minHolderCount: SCREENING.minHolderCount,
      maxAgeMs: SCREENING.maxAgeMs,
      minCompositeScore: SCREENING.minCompositeScore,
      originality: {
        minScore: 60,
        minMargin: 12,
        cohortWindowMs: 180_000,
        singletonDelayMs: 45_000,
      },
    },
    gmgn: {
      interval: '5m',
      orderBy: 'volume',
      limit: 50,
      minVolumeUsd: SCREENING.minVolume1hUsd,
    },
    safety: {
      bundlerCheckEnabled: true,
      rugSignalCheckEnabled: true,
      bundlerCheckIntervalMs: 30_000,
    },
  };
}

/**
 * Singleton runtime-config store. Reads/writes `config/runtime.json`, merging
 * any on-disk overrides over the seed defaults so a partial or stale file never
 * loses newly added keys. Emits `'change'` after every successful write.
 */
class ConfigManager extends EventEmitter {
  private config: RuntimeConfig;
  /** Live SOL/USD price, updated periodically from Jupiter. */
  private _solPriceUsd: number = SCREENING.solPriceUsd;

  constructor() {
    super();
    this.config = this.load();
  }

  /** Live SOL/USD price (falls back to SCREENING.solPriceUsd). */
  get solPriceUsd(): number { return this._solPriceUsd; }
  setSolPriceUsd(price: number) { if (price > 0) this._solPriceUsd = price; }

  /** Live config object. Callers should read fields at the point of use. */
  get(): RuntimeConfig {
    return this.config;
  }

  isDryRun(): boolean {
    return this.config.dryRun;
  }

  isProduction(): boolean {
    return this.config.mode === 'production';
  }

  /** Read a value by dot path, e.g. `main.tradeAmountSol`. */
  getByPath(dotPath: string): unknown {
    return dotPath.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, this.config);
  }

  /**
   * Set a value by dot path and persist. Returns the new value. Validation /
   * clamping is the caller's responsibility (the panel enforces min/max).
   */
  setByPath(dotPath: string, value: unknown): unknown {
    const keys = dotPath.split('.');
    const last = keys.pop();
    if (!last) throw new Error(`Invalid config path: ${dotPath}`);

    let target: Record<string, unknown> = this.config as unknown as Record<string, unknown>;
    for (const key of keys) {
      const next = target[key];
      if (!next || typeof next !== 'object') {
        throw new Error(`Invalid config path segment: ${key} in ${dotPath}`);
      }
      target = next as Record<string, unknown>;
    }

    target[last] = value;
    this.persist();
    this.emit('change', dotPath, value, this.config);
    logger.info('Config updated', { path: dotPath, value });
    return value;
  }

  private load(): RuntimeConfig {
    const defaults = buildDefaults();
    try {
      if (fs.existsSync(RUNTIME_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf-8')) as Partial<RuntimeConfig>;
        const merged = this.merge(defaults, raw);
        logger.info('Runtime config loaded', { file: RUNTIME_FILE });
        return merged;
      }
    } catch (err) {
      logger.warn('Could not load runtime.json — seeding defaults', { err: String(err) });
    }
    this.persist(defaults);
    return defaults;
  }

  /** Per-section shallow merge so missing/extra keys never drop a default. */
  private merge(defaults: RuntimeConfig, raw: Partial<RuntimeConfig>): RuntimeConfig {
    return {
      mode: raw.mode === 'production' || raw.mode === 'test' ? raw.mode : defaults.mode,
      dryRun: typeof raw.dryRun === 'boolean' ? raw.dryRun : defaults.dryRun,
      main: { ...defaults.main, ...(raw.main ?? {}) },
      risk: { ...defaults.risk, ...(raw.risk ?? {}) },
      strategy: { ...defaults.strategy, ...(raw.strategy ?? {}) },
      screening: { ...defaults.screening, ...(raw.screening ?? {}) },
      gmgn: { ...defaults.gmgn, ...(raw.gmgn ?? {}) },
      safety: { ...defaults.safety, ...(raw.safety ?? {}) },
    };
  }

  private persist(config: RuntimeConfig = this.config): void {
    try {
      const dir = path.dirname(RUNTIME_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify(config, null, 2));
    } catch (err) {
      logger.error('Failed to persist runtime.json', { err: String(err) });
    }
  }
}

export const configManager = new ConfigManager();
