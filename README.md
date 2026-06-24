# Aurelian — Solana Memecoin Sniper Bot

Automated trading bot for Solana low-cap memecoins. Screens tokens via GMGN API, executes swaps through Jupiter, and manages positions with configurable TP/SL strategies — all controllable via Telegram.

> **Disclaimer:** This software is experimental and provided for educational purposes only. Use at your own risk. This is not financial advice. Trading cryptocurrency carries significant risk of loss.

---

## How It Works

### 1. Token Discovery

The bot polls GMGN's ranked token API every 15 seconds, fetching the top 50 tokens by volume. New tokens are grouped into **theme cohorts** — tokens sharing the same symbol or name (e.g. multiple "BULLY" copies).

### 2. Originality Scoring (Anti-PVP)

When multiple tokens share the same theme, the bot scores each one (0-100) across 6 dimensions:

- **First-mover** (25pt) — earliest creation timestamp wins
- **Holder lead** (20pt) — most holders vs siblings
- **Liquidity lead** (15pt) — deepest LP vs siblings
- **Smart money** (15pt) — smart degen + renowned wallet count
- **Distribution** (15pt) — penalizes high top10%, fresh wallets, bundler rate, entrapment
- **Momentum** (10pt) — volume + buy/sell pressure

Only the **winner** (score ≥60, margin ≥12 over #2) is emitted as a candidate. If no clear winner exists, the entire cohort is skipped.

### 3. Singleton Safety Gate

Tokens with no competing siblings (singletons) get extra scrutiny since there's no comparison baseline:

- Top 10 holders ≤ 65%
- Holders ≥ 50
- Entrapment ratio ≤ 40%
- Tolerance budget: max 1 fail before rejection

### 4. Screening Pipeline

Each candidate passes through multiple gates before execution:

1. **TokenFilter** — market cap, liquidity, holders, score, age, B/S ratio, volume, price change filters
2. **Anti-Knife-Catch** — rejects tokens dumping >40% in 1 hour
3. **Momentum Penalty** — negative 5m price change penalizes score by -5 points
4. **1m Price Change Filter** — rejects extreme 1m moves (configurable -3% to +100%)
5. **Smart Money Filter** — requires minimum smart degen count (default 1)
6. **Volume Confirmation** — skips if vol24h=0 or 5m change ≤ -10%
7. **RugChecker** — on-chain mint/freeze authority verification, anti-honeypot sell simulation via Jupiter
8. **BundlerDetector** — Helius transfer burst detection (active 30s window), blacklist wallet learning
9. **canSellBack probe** — simulates a sell via Jupiter before buying to confirm route exists
10. **Jupiter Quote Recheck** — re-fetches price before buy, aborts if >15% gap from GMGN price or price impact >10%

### 5. Execution

Buys are executed through Jupiter swap with configurable slippage and priority fees. The bot tracks actual on-chain token balance after each trade. Auto-reclaims SPL token account rent (~0.002 SOL) after 100% sell.

### 6. Position Management

Once in a position, the bot monitors on two independent timers:

**Standard checks (5s interval):**
- **Take Profit** — configurable (default +30%), sells partial (default 40%), remaining rides trailing stop
- **Trailing Stop** — trails from peak price with **tiered tightening** as profit grows
- **Soft Stop Loss** — grace period + confirmations before triggering (default -20%)
- **Hard Stop Loss** — immediate close (default -25%)
- **Fail-Closed** — after N consecutive price-feed misses, force-sells to avoid holding dead tokens
- **Force-Probe Route** — every 30 seconds, verifies Jupiter swap route still exists even when Price API returns valid prices. Catches stale-price scenarios where LP was pulled.
- **Timeout** — closes flat/losing positions after configurable age

**Fast trailing tick (2s interval):**
- Runs only for positions with TP already hit (`firstTargetHit=true`)
- Fetches fresh price via Jupiter swap-quote (Pump.fun tokens aren't indexed by Price API)
- Applies spike guard and checks trailing stop independently
- Reduces trailing-stop overshoot from ~11pp (5s window) to ~4pp (2s window)

**Tiered Trailing Stop:**

Trailing stop tightens as unrealized profit grows — locks in gains on big runners:

| Profit Level | Trail Drop % |
|---|---|
| Base (default) | 15% |
| 100%+ | 12% |
| 200%+ | 9% |
| 500%+ | 7% |
| 1000%+ | 5% |

All tiers are configurable via the Telegram `/config` → Trailing panel.

**Price Spike Guard:**

Jupiter swap-quote can return bogus prices for low-liquidity tokens. The spike guard rejects readings where the new price is >10× or <0.1× the last valid price. After 3 consecutive rejects, the latest reading is force-accepted to avoid stale deadlock.

**Partial Sell Retry:**

If a partial sell fails (no route, simulation fail), the bot retries up to 3 times with exponential backoff (2s/4s/8s). If all retries fail, a Telegram alert is sent and the position continues with trailing stop active. `firstTargetHit` is only set on successful sell.

**Honeypot Handling:**

When a token fails to sell after max retries (10x), the position is recorded as -100% PnL in trade history, a Telegram notification is sent, and the position is removed. Emergency force-close (price_feed_dark, rug_signal, stop_loss, etc.) bypasses the sell-back minimum age gate for young honeypots.

**Recently-Traded Dedup:**

After selling a token, a 2-hour cooldown is enforced before re-entering the same token. Persisted to disk (`data/recently-traded.json`) so it survives restarts.

### 7. Runtime Safety Monitors

While a position is open, additional monitors run periodically:

- **RugSignalDetector** — compares current GMGN metrics against entry snapshot (holder exodus, top10 consolidation, liquidity drain, entrapment spike, creator over-concentration, fresh wallet farms)
- **BundlerDetector (runtime, dump-only)** — detects active transfer bursts on held tokens. Only force-closes when bundler is **selling/dumping** (price drops during burst). Bundler buying/accumulation is treated as positive momentum and does not trigger a close.
- **Liquidity Monitor** — checks every 60 seconds, alerts on >50% drop from entry
- **Smart Money Flow** — re-fetches smart degen count; alerts if smart wallets fully exit (no auto-sell)
- **Price Spike Guard** — rejects anomalous price readings (see above)

### 8. Cohort Block

After closing any position, all tokens sharing the same theme are temporarily blocked:

- **Negative outcome** (SL, rug, bundler, stuck) → 30 minute block
- **Positive outcome** (TP) → 10 minute block

This prevents buying PVP copies/honeypots after trading the original.

### 9. Telegram Interface

All activity is reported via Telegram:

- Position open/close notifications with full signal data (price, MC, vol, holders, age, score, safety, GMGN link)
- Real-time price and liquidity alerts
- `/positions` — view open positions with live PnL, partial sell buttons, GMGN link
- `/pnl` — view trading history, win rate, recent trades with close reason
- `/config` — inline keyboard panel to adjust all parameters live
- `/start` / `/stop` — arm/disarm autonomous trading

---

## Architecture

```
GMGN API (ranked tokens, 15s poll)
    │
    ▼
TokenDiscovery
    ├── Theme grouping (themeKey normalization)
    ├── Cohort buffer (3 min rolling window)
    ├── OriginalityScorer (0-100, 6 components)
    ├── Singleton safety gate
    ├── Recently-traded dedup (2h, persisted)
    └── Cohort block map
         │
         ▼
TokenFilter (mcap, liq, holders, score, age, B/S, volume, price change)
    │
    ▼
RugChecker (mint/freeze authority, sell simulation)
    │
    ▼
ExecutionEngine
    ├── Jupiter quote recheck (15% gap abort)
    ├── Price impact check (>10% abort)
    ├── Momentum penalty (-5pt for negative 5m)
    └── Jupiter swap (buy/sell with retry)
         │
         ▼
PositionManager
    ├── Price monitor (5s, swap-quote fallback for Pump.fun)
    ├── Fast trailing tick (2s, TP-hit positions only)
    ├── Tiered trailing stop (tightens with profit)
    ├── Price spike guard (10× ratio limit)
    ├── Force-probe route (30s, catches stale prices)
    ├── TP/SL/Trailing logic (partial sell with 3x retry)
    ├── RugSignalDetector (GMGN snapshot comparison)
    ├── BundlerDetector (runtime, dump-only mode)
    ├── Smart money flow monitoring
    ├── Liquidity monitor (60s, >50% drop alert)
    ├── Honeypot stuck → -100% PnL recording
    └── Fail-closed (N misses → force-sell)
         │
         ▼
TelegramBot (notifications + /config panel with Trailing tab)
```

---

## Setup

### Prerequisites

- Node.js 20+
- A funded Solana wallet (base58 private key)
- Helius RPC endpoint (recommended)
- GMGN API key
- Telegram bot token + chat ID

### Installation

```bash
npm install
cp .env.example .env
# Fill in your keys in .env
npm run build
node dist/index.js
```

### Running in dry-run mode

Set `DRY_RUN=true` in `.env` — the bot will scan, score, and log tokens but will not execute any swaps. Useful for validating the screening pipeline before going live.

---

## Configuration

### Environment variables

See `.env.example` for the full list.

| Variable | Description |
|---|---|
| `DRY_RUN` | `true` = no real trades, `false` = live trading |
| `NODE_ENV` | `test` or `production` (affects static config values) |
| `HELIUS_API_KEY` | Helius RPC API key (bundling detection, on-chain checks) |
| `GMGN_API_KEY` | GMGN OpenAPI key (token data, ranked tokens) |
| `JUPITER_API_KEY` | Jupiter Pro API key (swaps, price feeds) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID for notifications |
| `WALLET_PRIVATE_KEY` | Base58 private key of your Solana wallet |
| `RPC_URL` | Solana RPC endpoint |

### Runtime config (`config/runtime.json`)

All trading parameters are stored here and can be changed live without restarting:

- **Strategy**: TP %, SL %, trailing %, trade size, max concurrent positions
- **Screening**: min/max mcap, min liquidity, min holders, min score, age, B/S ratio, volume, price change filters, smart money, bundler rate, entrapment
- **Trailing**: tiered trailing toggle, base trail %, tier thresholds (100%/200%/500%/1000%+)
- **Safety**: bundler check, rug signal check, bundler detector thresholds (R1/R2/R3), dump-only mode, adaptive sizing, time-of-day awareness
- **Slippage**: buy/sell slippage in bps, priority fee in lamports

### Telegram `/config` panel

Send `/config` to open an inline keyboard panel with tabs:

- **Main** — trade size, max positions, start/stop
- **Risk** — daily loss limit, max consecutive losses, cooldown, per-trade max
- **Strategy** — TP/SL/trailing percentages, slippage, priority fee, timeout
- **Trailing** — tiered trailing toggle, base trail %, per-tier thresholds
- **Screening** — all filter thresholds (mcap, liq, holders, score, age, price changes, smart money, bundler, entrapment)
- **GMGN** — discovery interval, order by, limit, min volume
- **Safety** — bundler/rug checks, detector thresholds, dump-only mode, adaptive sizing, time-of-day

Changes are persisted to `config/runtime.json` immediately and take effect on the next cycle.

---

## Project Structure

```
src/
  config/          # ConfigManager, constants, static config
  discovery/       # GmgnClient, TokenDiscovery (cohort buffer, originality)
  screening/       # TokenFilter, RugChecker, BundlerDetector, RugSignalDetector, OriginalityScorer, themeKey
  execution/       # JupiterClient, ExecutionEngine (swap execution)
  position/        # PositionManager (TP/SL/trailing/tiered/fail-closed/force-probe/spike-guard)
  risk/            # RiskManager (daily loss limit, streak tracking)
  logger/          # Logger, TradeHistory
  telegram/        # TelegramBot, config panel (7 tabs), inline keyboard handlers
  dryrun/          # DryRunLogger (virtual PnL tracking)
  types/           # TypeScript type definitions
  utils/           # Solana helpers, markdown escaping
  index.ts         # Entry point, wiring, main loop
config/
  runtime.json     # Live-editable runtime parameters (not committed)
data/
  positions.json   # Open positions (persisted for crash recovery)
  recently-traded.json  # Dedup cooldown map (2h TTL)
  bundler-history.json  # Bundler detection history
  sol-price-cache.json  # SOL price cache (24h TTL)
```

---

## License

MIT
