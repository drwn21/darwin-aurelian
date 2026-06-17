# Aurelian — Solana Memecoin Sniper Bot

Automated trading bot for Solana low-cap tokens using GMGN screening, Jupiter swaps, and Telegram notifications.

> **Disclaimer:** This software is experimental and provided for educational purposes only. Use at your own risk. This is not financial advice. Trading cryptocurrency carries significant risk of loss.

---

## Features

- **TokenFilter** — multi-criteria filter (liquidity, volume, age, holder concentration)
- **BundlerDetector** — identifies bundled launches and coordinated wallet activity
- **RugSignalDetector** — detects honeypots, frozen LPs, and dev sell patterns
- **OriginalityScorer** — cohort-based anti-PVP scoring that deprioritizes tokens already held by known sniper wallets
- **Liquidity Monitor** — continuous LP depth tracking with exit triggers
- **Force-probe Route** — pre-flight Jupiter route probe to confirm swap viability before execution
- **Cohort Block** — blocks tokens with excessive overlap against your own position cohort
- **Telegram UI** — real-time alerts, position updates, and a `/config` panel for live parameter adjustment

---

## Architecture

```
GmgnClient
    └── TokenDiscovery (cohort buffer + originality scoring)
            └── TokenFilter
                    └── RugChecker
                            └── ExecutionEngine (Jupiter swap)
                                    └── PositionManager (TP / SL / trailing / fail-closed)
                                                └── TelegramBot (alerts + /config panel)
```

---

## Setup

### Prerequisites

- Node.js 20+
- A funded Solana wallet (base58 private key)
- Helius RPC endpoint (recommended)
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

Set `DRY_RUN=true` in `.env` — the bot will scan and score tokens but will not execute any swaps.

---

## Configuration

### Environment variables

See `.env.example` for the full list of required variables.

### Runtime config (`config/runtime.json`)

Runtime parameters (position size, TP/SL percentages, filter thresholds, etc.) are stored in `config/runtime.json` and can be adjusted live without restarting the bot.

### Telegram `/config` panel

Send `/config` to your bot to open an inline keyboard panel. From there you can:

- Toggle dry-run mode
- Adjust position size and max concurrent positions
- Set TP / SL / trailing-stop percentages
- Enable or disable individual filters
- View current runtime config

Changes made through the panel are persisted to `config/runtime.json` immediately.

---

## Project Structure

```
src/
  clients/       # GMGN and RPC clients
  discovery/     # Token discovery, cohort tracking, originality scoring
  filters/       # TokenFilter, BundlerDetector, RugSignalDetector
  execution/     # Jupiter swap execution, force-probe route
  positions/     # PositionManager (TP/SL/trailing/fail-closed)
  telegram/      # TelegramBot, config panel
  index.ts       # Entry point
config/
  runtime.json   # Live-editable runtime parameters (not committed)
```

---

## License

MIT
