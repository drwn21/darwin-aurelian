// ─── Token Discovery ──────────────────────────────────────────────────────────

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  marketCap: number;       // USD
  price: number;           // USD
  priceChange1m: number;   // %
  priceChange5m: number;   // %
  priceChange1h: number;   // %
  volume1h: number;        // USD
  volume24h: number;       // USD
  liquidity: number;       // USD
  holderCount: number;
  top10HolderPercent: number; // 0-100 percentage held by top 10 wallets
  createdAt: number;       // unix timestamp
  mintAuthRevoked: boolean;
  freezeAuthRevoked: boolean;
  lpBurned: boolean;
  lpBurnedPercent: number; // % of LP tokens burned
  devHoldingPercent: number;
  // GMGN-specific fields (from /v1/market/rank and /v1/token/info)
  bundlerRate?: number;       // 0-1, fraction of bundler txs
  freshWalletRate?: number;   // 0-1, fraction from fresh wallets
  devTeamHoldRate?: number;   // 0-1, dev+team holding ratio
  buys?: number;              // buy swap count
  sells?: number;             // sell swap count
  washTrading?: boolean;      // wash trading detected
  isHoneypot?: boolean;       // GMGN honeypot flag
  isWashTrading?: boolean;    // GMGN wash trading flag
  // Pre-pump / quality signals (from GMGN /v1/market/rank and /v1/token/info).
  // All optional — older feeds and non-GMGN callers simply omit them, and every
  // consumer treats a missing value as the neutral 0, so behaviour is unchanged
  // when they're absent.
  entrapmentRatio?: number;   // 0-1, top-trader entrapment fraction (rug risk)
  smartDegenCount?: number;   // count of "smart money" wallets in the token
  sniperCount?: number;       // count of sniper bots that bought
  hotLevel?: number;          // 0-3 GMGN heat level
  creatorHoldRate?: number;   // 0-1, fraction of supply the creator still holds
  buys24h?: number;           // 24h buy swap count
  sells24h?: number;          // 24h sell swap count
  renownedCount?: number;     // count of "renowned" wallets in the token (GMGN)
  /** True for trenches/near-completion bonding-curve tokens (MC ≈ $0 pre-bond). */
  isTrenches?: boolean;
}

/**
 * Snapshot of a token's GMGN metrics captured at position entry, so the runtime
 * rug-signal detector can compare current values against the entry baseline.
 */
export interface GmgnSnapshot {
  holders: number;
  liquidity: number;     // USD
  top10: number;         // 0-100 percentage
  entrapment: number;    // 0-1 fraction
  creatorHold: number;   // 0-1 fraction
  freshWallet: number;   // 0-1 fraction
  bundlerRate: number;   // 0-1 fraction
  snapshotAt: number;    // unix ms
}

export interface GmgnNewPairResponse {
  code: number;
  data: {
    pairs: RawGmgnPair[];
  };
}

export interface RawGmgnPair {
  base_address: string;
  base_symbol: string;
  base_name: string;
  base_decimals: number;
  market_cap: number;
  price_usd: number;
  price_change_percent5m: number;
  price_change_percent1h: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity: number;
  holder_count: number;
  top10_holder_rate: number;
  open_timestamp: number;
  is_mintable: boolean;
  is_freezeable: boolean;
  burn_ratio: string;         // "100%" or "80%"
  dev_token_burn_amount: number;
}

// ─── Position / Trade ─────────────────────────────────────────────────────────

export type PositionStatus = 'open' | 'closed' | 'pending_sell' | 'stuck';

export interface Position {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  entryPrice: number;        // SOL per whole token at entry (solSpent / tokensReceived)
  currentPrice: number;      // SOL per whole token now (tokenUSD / solUSD)
  peakPrice: number;         // highest SOL-denominated price since entry
  firstTargetHit: boolean;   // true after partial sell at TP
  slBelowCount: number;      // consecutive checks below soft SL
  entryAmountSol: number;
  tokensReceived: number;
  /** Token decimals — needed to convert raw `tokensReceived` to whole tokens
   *  when valuing the position (currentPrice is SOL per whole token). */
  decimals?: number;
  /** USD market cap captured at entry (from GMGN token data), for display. */
  marketCapUsd?: number;
  /** USD liquidity captured at entry, for liquidity-drop monitoring. */
  entryLiquidityUsd?: number;
  entryTxSig: string;
  openedAt: number;          // unix ms
  closedAt?: number;
  exitPrice?: number;
  exitAmountSol?: number;
  exitTxSig?: string;
  status: PositionStatus;
  takeProfitPct: number;     // e.g. 100 = 2x
  stopLossPct: number;       // e.g. -25
  unrealisedPnlSol?: number;
  realisedPnlSol?: number;
  closeReason?: CloseReason;
  sellRetryCount?: number;
  /** Consecutive transient sell failures (Jupiter/RPC blips). Unlike
   *  sellRetryCount these never force-close the position — once they exceed
   *  strategy.maxTransientSellRetries we alert the operator and keep retrying. */
  transientRetryCount?: number;
  /** True once the transient-retry operator alert has fired — de-dupes it. */
  transientRetryAlerted?: boolean;
  /** GMGN metrics captured at entry, used by the runtime rug-signal detector. */
  gmgnSnapshot?: GmgnSnapshot;
  /** Last unix ms a bundler check ran for this position (throttling). */
  lastBundlerCheckAt?: number;
  /** Price (SOL/token) at the most recent bundler check — used to detect
   *  dump vs accumulation when a bundler burst fires. */
  priceAtLastBundlerCheck?: number;
  /** Last unix ms a rug-signal check ran for this position (throttling). */
  lastRugCheckAt?: number;
  /** In-flight sell lock — guards against concurrent TP/SL sells racing on the
   *  same position. Transient: reset to false on load. */
  selling?: boolean;
  /** Consecutive price-feed misses. Used to fail-closed (sell) a position whose
   *  price can no longer be queried — a likely-dead/rugged token. */
  priceFailCount?: number;
  /** Theme cohort key — used to block all siblings after a negative close. */
  themeKey?: string;
  /** Consecutive force-probe failures (no swap route despite valid Price API). */
  routeProbeFailCount?: number;
  /** Last price reading that passed the sanity check (not a spike). Used as
   *  the baseline for rejecting anomalous readings from Jupiter swap-quotes. */
  lastValidPrice?: number;
  /** Count of consecutive price readings rejected by the spike detector. After
 *  MAX_CONSECUTIVE_SPIKE_REJECTS rejections the latest reading is accepted
 *  to prevent a position from sitting with a stale price forever. */
  priceSpikeRejectCount?: number;
  /** Priority fee paid for the buy transaction, in SOL. */
  buyPriorityFeeSol?: number;
  /** True if TP was detected but the partial sell ultimately failed after all retries. */
  partialSellFailed?: boolean;
  /** GMGN smart-money wallet count captured at entry, for post-entry flow
   *  monitoring (alert if it later drops to 0). */
  entrySmartDegenCount?: number;
  /** Last unix ms a smart-money flow check ran for this position (throttling). */
  lastSmartMoneyCheckAt?: number;
  /** True once a 'smart money exiting' alert has fired — de-dupes the alert. */
  smartMoneyExitAlerted?: boolean;
}

export type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'hard_stop_loss'
  | 'manual'
  | 'timeout'
  | 'sell_stuck'
  | 'bundler_detected'
  | 'rug_signal'
  | 'price_feed_dark'
  | 'liquidity_drop'
  | 'dead_token_no_routes'
  | 'trailing_stop';

export interface TradeRecord {
  positionId: string;
  tokenAddress: string;
  tokenSymbol: string;
  side: 'buy' | 'sell';
  amountSol: number;
  price: number;
  txSig: string;
  timestamp: number;
  pnlSol?: number;
  pnlPct?: number;
  closeReason?: string;
  /** Priority fee paid for this transaction, in SOL. */
  priorityFee?: number;
}

// ─── Screening ────────────────────────────────────────────────────────────────

export interface FilterResult {
  passed: boolean;
  reasons: string[];
  score: number;         // composite 0–100, higher = more attractive
}

/** Coarse rug verdict derived from the numeric risk score + hard flags. */
export type RiskLevel = 'SAFE' | 'WARNING' | 'DANGER';

export interface RiskScore {
  score: number;         // 0–100, higher = riskier
  flags: string[];
  isRug: boolean;
  level: RiskLevel;
}

// ─── Execution ────────────────────────────────────────────────────────────────

export interface SwapResult {
  success: boolean;
  txSig?: string;
  tokensReceived?: number;
  solSpent?: number;
  error?: string;
  /** SOL rent reclaimed by closing the empty SPL token account after a 100% sell. */
  reclaimedSol?: number;
  /**
   * Classifies a failed swap so the caller can tell a real honeypot from a
   * transient outage:
   *  - 'permanent' — no route / simulation failed (token is unsellable)
   *  - 'transient' — rate-limited (429) / timeout / network error (retry later)
   */
  failureType?: 'permanent' | 'transient';
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

// ─── Risk ─────────────────────────────────────────────────────────────────────

export interface RiskState {
  dailyPnlSol: number;
  tradesOpenCount: number;
  lastTradeAt?: number;
  consecutiveLosses: number;
  dailyResetAt: number;          // unix ms
  startingBalanceSol: number;    // snapshot used for the % daily-loss limit
}

export interface CanTradeResult {
  allowed: boolean;
  reason?: string;
}

// ─── Bot State ────────────────────────────────────────────────────────────────

export type BotMode = 'autonomous' | 'manual' | 'stopped';

export interface BotState {
  mode: BotMode;
  startedAt?: number;
  totalTrades: number;
  totalPnlSol: number;
}
