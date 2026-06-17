export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';
export const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';

export const LAMPORTS_PER_SOL = 1_000_000_000;

// Polling intervals (ms)
export const DISCOVERY_INTERVAL_MS = 15_000;
export const PRICE_UPDATE_INTERVAL_MS = 5_000;
export const POSITION_CHECK_INTERVAL_MS = 5_000;

// Jupiter defaults
export const DEFAULT_SLIPPAGE_BPS = 300;     // 3%
export const MAX_SLIPPAGE_BPS = 1000;        // 10% for small caps
export const DEFAULT_PRIORITY_FEE_LAMPORTS = 500_000; // 0.0005 SOL

export const TX_CONFIRM_TIMEOUT_MS = 60_000;
