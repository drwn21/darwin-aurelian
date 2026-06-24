export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';
export const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';

export const LAMPORTS_PER_SOL = 1_000_000_000;

// Polling intervals (ms)
export const DISCOVERY_INTERVAL_MS = 15_000;
export const PRICE_UPDATE_INTERVAL_MS = 5_000;
export const POSITION_CHECK_INTERVAL_MS = 5_000;

// Fast-path trailing check — only for positions with firstTargetHit=true.
// Reduces trailing-stop overshoot from ~11pp (5s window) to ~4pp (2s window).
export const TRAILING_CHECK_INTERVAL_MS = 2_000;

// Jupiter defaults
export const DEFAULT_SLIPPAGE_BPS = 300;     // 3%
export const MAX_SLIPPAGE_BPS = 1000;        // 10% for small caps
export const DEFAULT_PRIORITY_FEE_LAMPORTS = 500_000; // 0.0005 SOL

export const TX_CONFIRM_TIMEOUT_MS = 60_000;

// ─── Price Spike Detection ───────────────────────────────────────────────────
// Jupiter swap-quote endpoint can return stale or wildly incorrect prices for
// low-liquidity tokens (known issue — the quote engine may pick an outlier
// route or stale LP).  A single bogus reading (e.g. 2000× spike) can set a
// fake peakPrice, trigger TP at an astronomical PnL, then trigger trailing
// stop on the next real reading because the price "dropped" 99.9%.
// These constants guard against that by rejecting anomalous price movements.

/** Maximum allowed ratio between new and previous price before the reading
 *  is rejected as a spike.  E.g. 10 = new price can be at most 10× the old
 *  price; anything higher is considered a data error. */
export const MAX_PRICE_RATIO = 10;

/** After this many consecutive rejected (spike) readings, accept the latest
 *  reading anyway so a position doesn't sit with a stale price forever. */
export const MAX_CONSECUTIVE_SPIKE_REJECTS = 3;
