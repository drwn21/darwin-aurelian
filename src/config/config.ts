import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ─── Environment ──────────────────────────────────────────────────────────────

export const ENV = {
  privateKey: required('PRIVATE_KEY'),
  rpcEndpoint: optional('RPC_ENDPOINT', 'https://api.mainnet-beta.solana.com'),
  // Helius Enhanced Transactions API key — only needed for the bundler detector
  // (api.helius.xyz/v0). Absent ⇒ the detector no-ops and bundler checks are
  // skipped, so this stays fully optional.
  heliusApiKey: process.env['HELIUS_API_KEY'],
  jupiterApiKey: process.env['JUPITER_API_KEY'],
  gmgnBaseUrl: optional('GMGN_BASE_URL', 'https://openapi.gmgn.ai'),
  gmgnApiKey: process.env['GMGN_API_KEY'],
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  nodeEnv: optional('NODE_ENV', 'test') as 'production' | 'test',
} as const;

export const IS_PRODUCTION = ENV.nodeEnv === 'production';
export const DRY_RUN = (process.env['DRY_RUN'] ?? 'false') === 'true';

// ─── Strategy Parameters ──────────────────────────────────────────────────────
// DEGEN MODE: spray small, exit fast, tight safety gate

export const STRATEGY = {
  // Position sizing (SOL) — small size, spray across 5 positions
  tradeAmountSol: IS_PRODUCTION ? 0.15 : 0.1,
  maxPositionSizeSol: IS_PRODUCTION ? 0.3 : 0.2,

  // Profit / Loss targets (%) — partial TP + trailing
  takeProfitPct: 50,        // TP trigger: +50% → sell firstTargetSellPct
  firstTargetSellPct: 50,   // sell 50% at TP
  trailingStopPct: 10,      // trail drop: 10% from peak → close remainder
  useTrailingStop: true,    // enable trailing after partial sell
  stopLossPct: -20,         // soft SL: -20% (after grace + confirms)
  hardStopLossPct: -30,     // hard SL: -30% (immediate, no grace)
  slGracePeriodMs: 2 * 60 * 1000,  // 2 min grace before SL arms
  slConfirms: 2,            // need 2 consecutive checks below SL

  // Position limits — more concurrent, spray approach
  maxConcurrentPositions: 5,
  positionTimeoutMs: 4 * 60 * 60 * 1000,  // force close after 4 hours

  // Risk controls — degen mode: wider limits, faster cooldown
  dailyLossLimitPct: 20,    // 20% of allocated capital
  dailyLossLimitSol: IS_PRODUCTION ? 1.0 : 0.5,
  maxConsecutiveLosses: 6,  // stop after 6 consecutive losses
  cooldownAfterLossMs: 45 * 1000,  // 45s cooldown between trades

  // Slippage — wider for low-liq degen tokens
  // 15% buys, 20% sells — must be able to exit fast
  buySlippageBps: 1500,     // 15%
  sellSlippageBps: 2000,    // 20%

  // Jupiter priority fee (lamports)
  // Auto mode with higher cap for degen sniping
  priorityFeeLamports: IS_PRODUCTION ? 10_000_000 : 5_000_000,  // 0.01 SOL prod, 0.005 SOL test
  maxPriorityFeeLamports: 15_000_000,  // cap at 0.015 SOL
  useMevProtection: true,   // Jupiter MEV protect / Jito bundles

  // Anti-honeypot: simulate sell before buying
  simulateSellBeforeBuy: true,
  maxSellPriceImpactPct: 90,  // reject if sell impact >90%
} as const;

// ─── Screening Criteria ───────────────────────────────────────────────────────
// DEGEN MODE: low mcap, early tokens, but TIGHT safety gate

export const SCREENING = {
  // Market cap range (USD) — degen range, early tokens
  // $15K-$150K: below $15K = mostly dead/scam, $15K-$150K = survived first wave
  minMarketCapUsd: 20_000,
  maxMarketCapUsd: 150_000,

  // Liquidity — absolute min + ratio gate
  // Ratio gate is key: prevents "thin liq pumped mcap" rugs
  minLiquidityUsd: 12_000,
  minLiquidityToMcapRatio: 0.12,  // liq must be >= 12% of mcap

  // Volume
  minVolume1hUsd: 2_000,

  // Token age — 20 min minimum (survive instant-rug wave), 6h max
  minAgeMs: 15 * 60 * 1000,      // 15 minutes minimum
  maxAgeMs: 6 * 60 * 60 * 1000,  // 6 hours maximum

  // Holder distribution — relaxed for new tokens
  minHolderCount: 40,
  maxTop10HolderPctWarn: 65,    // warn at 65% (new tokens are concentrated)
  maxTop10HolderPctReject: 85,  // reject at 85%

  // Momentum filter — slightly tighter to compensate for relaxed quality
  minBuySellRatio: 1.3,         // more buys than sells
  minSmartMoneyBuys: 1,         // at least 1 smart wallet buying

  // Rug protection — SAFETY GATE (binary pass/fail, NOT weighted score)
  // These are TIGHTER than quality filters — this is what saves you in degen range
  rejectMintAuthorityActive: true,     // infinite-supply rug
  rejectFreezeAuthorityActive: true,   // honeypot
  minLpBurnedOrLockedPct: 50,          // reject if <50% AND not locked
  rejectBundlerPct: 35,                // reject if >35% bundled (higher tolerance for new launches)
  rejectWashTradingScore: 60,          // reject if wash score >60 (TIGHT — fake volume ruins your score)
  rejectDevHoldingPct: 20,             // reject if dev holds >20%
  devSoldAction: 'warn' as const,      // dev sold = warn
  verifyAuthoritiesOnChain: true,      // MUST verify via RPC, GMGN data often stale on new tokens

  // Liquidity expressed in SOL
  minLiquiditySol: 10,
  solPriceUsd: 150,

  // Volume spike: 1h volume vs 24h hourly average
  minVolumeSpikeRatio: 1.3,

  // Composite score gate — lower for degen, safety gate does the heavy lifting
  minCompositeScore: 65,

  // Discovery order — newest first (most degen, earliest entry)
  discoveryOrderBy: 'created_at',
  discoveryDirection: 'desc',
} as const;

// ─── Score Weights (0-100, applied AFTER safety gate) ─────────────────────────

export const SCORE = {
  // Safety is now a binary gate, not weighted — these rank the survivors
  liquidity: 30,       // can you get out? (most important in low-liq range)
  volume: 20,          // trading activity
  momentum: 20,        // buy/sell ratio
  holders: 10,         // holder count (lower weight — new tokens have few holders)
  safetyQuality: 20,   // LP%, concentration within passing range
} as const;

// ─── Risk Management ──────────────────────────────────────────────────────────

export const RISK = {
  // Per-trade sizing (SOL) — small, spray approach
  perTradeSizeSol: STRATEGY.tradeAmountSol,
  maxPerTradeSizeSol: STRATEGY.maxPositionSizeSol,

  // Concurrency — more positions, smaller size each
  maxConcurrentPositions: STRATEGY.maxConcurrentPositions,

  // Daily loss limit: 20% of allocated capital
  dailyLossLimitPct: STRATEGY.dailyLossLimitPct,
  dailyLossLimitSol: STRATEGY.dailyLossLimitSol,

  // Consecutive-loss halt
  maxConsecutiveLosses: STRATEGY.maxConsecutiveLosses,
  cooldownAfterLossMs: STRATEGY.cooldownAfterLossMs,

  // Max drawdown halt: 35% of allocated capital → bot stops, review manually
  maxDrawdownHaltPct: 35,

  // Allocated capital the bot can touch (ring-fenced from total portfolio)
  allocatedCapitalSol: IS_PRODUCTION ? 5 : 1,
} as const;
