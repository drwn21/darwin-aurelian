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

- Top 10 holders must be ≤ 50%
- Fresh wallet rate must be ≤ 80%
- Holders must be ≥ 80
- Entrapment ratio must be ≤ 10%

### 4. Screening Pipeline

Each candidate passes through multiple gates before execution:

1. **TokenFilter** — market cap ($20K-$150K), liquidity (≥$12K), holders (≥40), score (≥65)
2. **RugChecker** — on-chain mint/freeze authority verification, anti-honeypot sell simulation via Jupiter
3. **BundlerDetector** — Helius transfer burst detection (active 30s window), blacklist wallet learning
4. **canSellBack probe** — simulates a sell via Jupiter before buying to confirm route exists

### 5. Execution

Buys are executed through Jupiter swap with configurable slippage (default 15%) and priority fees. The bot tracks actual on-chain token balance after each trade.

### 6. Position Management

Once in a position, the bot monitors every 5 seconds:

- **Take Profit** — configurable (default +30%), sells partial (default 50%), remaining rides trailing stop
- **Trailing Stop** — trails from peak price (default 5%)
- **Soft Stop Loss** — grace period + confirmations before triggering (default -20%)
- **Hard Stop Loss** — immediate close (default -30%)
- **Fail-Closed** — after 10 consecutive price-feed misses (~2.5 min), force-sells to avoid holding dead tokens
- **Force-Probe Route** — every 30 seconds, verifies Jupiter swap route still exists even when Price API returns valid prices. Catches stale-price scenarios where LP was pulled.

### 7. Runtime Safety Monitors

While a position is open, additional monitors run periodically:

- **RugSignalDetector** — compares current GMGN metrics against entry snapshot (holder exodus, top10 consolidation, liquidity drain, entrapment spike, creator over-concentration, fresh wallet farms)
- **BundlerDetector (runtime)** — detects active transfer bursts on held tokens
- **Liquidity Monitor** — checks every 60 seconds, alerts on >50% drop from entry

### 8. Cohort Block

After closing any position, all tokens sharing the same theme are temporarily blocked:

- **Negative outcome** (SL, rug, bundler, stuck) → 30 minute block
- **Positive outcome** (TP) → 10 minute block

This prevents buying PVP copies/honeypots after trading the original.

### 9. Telegram Interface

All activity is reported via Telegram:

- Position open/close notifications with PnL
- Real-time price and liquidity alerts
- `/positions` — view open positions with live PnL
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
    └── Cohort block map
         │
         ▼
TokenFilter (mcap, liq, holders, score)
    │
    ▼
RugChecker (mint/freeze authority, sell simulation)
    │
    ▼
ExecutionEngine (Jupiter swap)
    │
    ▼
PositionManager
    ├── Price monitor (5s, swap-quote fallback)
    ├── Force-probe route (30s, catches stale prices)
    ├── TP/SL/Trailing logic
    ├── RugSignalDetector (GMGN snapshot comparison)
    ├── BundlerDetector (Helius transfer burst)
    ├── Liquidity monitor (60s, >50% drop alert)
    └── Fail-closed (10 misses → force-sell)
         │
         ▼
TelegramBot (notifications + /config panel)
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
- **Screening**: min/max mcap, min liquidity, min holders, min score, originality thresholds
- **Safety**: bundler check, rug signal check, price fail-close threshold, force-probe interval
- **Slippage**: buy/sell slippage in bps, priority fee in lamports

### Telegram `/config` panel

Send `/config` to open an inline keyboard panel with tabs:

- **Main** — trade size, max positions, start/stop
- **Strategy** — TP/SL/trailing percentages
- **Screening** — filter thresholds
- **Safety** — toggle bundler/rug checks

Changes are persisted to `config/runtime.json` immediately and take effect on the next cycle.

---

## Project Structure

```
src/
  config/          # ConfigManager, constants, static config
  discovery/       # GmgnClient, TokenDiscovery (cohort buffer, originality)
  screening/       # TokenFilter, RugChecker, BundlerDetector, RugSignalDetector, OriginalityScorer, themeKey
  execution/       # JupiterClient, ExecutionEngine (swap execution)
  position/        # PositionManager (TP/SL/trailing/fail-closed/force-probe)
  risk/            # RiskManager (daily loss limit, streak tracking)
  logger/          # Logger, TradeHistory
  telegram/        # TelegramBot, config panel, inline keyboard handlers
  dryrun/          # DryRunLogger (virtual PnL tracking)
  utils/           # Solana helpers, markdown escaping
  index.ts         # Entry point, wiring, main loop
config/
  runtime.json     # Live-editable runtime parameters (not committed)
```

---

## License

MIT
