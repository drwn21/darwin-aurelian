# GMGN Sniper Bot — Architecture

Solana memecoin sniper bot built in Node.js/TypeScript. Discovers new small-cap tokens via the GMGN API, screens them against on-chain safety criteria, executes swaps through Jupiter, and manages positions autonomously with configurable take-profit/stop-loss exits. A Grammy Telegram bot provides runtime control and notifications.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         TELEGRAM BOT                            │
│  /start /stop /buy /sell /status /positions /pnl /balance       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ commands / notifications
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR (main.ts)                      │
│  BotMode: autonomous | manual | stopped                          │
│  poll loop (15 s)                                                │
└───┬──────────────────┬──────────────────┬────────────────────────┘
    │                  │                  │
    ▼                  ▼                  ▼
┌──────────┐   ┌────────────┐   ┌──────────────────┐
│  TOKEN   │   │ SCREENING  │   │  RISK MANAGER    │
│DISCOVERY │──▶│  PIPELINE  │──▶│  canTrade()?     │
│          │   │            │   │                  │
│ GMGN API │   │ TokenFilter│   │ dailyPnl         │
│ new pairs│   │ RugChecker │   │ consecutiveLoss  │
│ trending │   │ risk score │   │ positionCount    │
└──────────┘   └────────────┘   └────────┬─────────┘
                                          │ allowed
                                          ▼
                              ┌───────────────────────┐
                              │   EXECUTION ENGINE    │
                              │                       │
                              │  Jupiter getQuote()   │
                              │  buildSwapTx()        │
                              │  sendAndConfirmTx()   │
                              └──────────┬────────────┘
                                         │ SwapResult
                                         ▼
                              ┌───────────────────────┐
                              │   POSITION MANAGER    │
                              │                       │
                              │  openPosition()       │
                              │  price poll  (5 s)    │◀─── Jupiter Price API
                              │  TP/SL check (5 s)    │
                              │  closePosition()      │
                              └──────────┬────────────┘
                                         │ closed position
                                         ▼
                              ┌───────────────────────┐
                              │   TRADE HISTORY /     │
                              │      LOGGER           │
                              │                       │
                              │ trades/history.json   │
                              │ structured log        │
                              └───────────────────────┘
```

---

## Module Reference

### `src/discovery/`

**`GmgnClient`** — HTTP client wrapping `https://gmgn.ai/defi/quotation/v1`.

| Method | GMGN Endpoint | Notes |
|---|---|---|
| `fetchNewTokens(limit)` | `GET /tokens/new_pairs/sol` | Ordered by `open_timestamp desc`. Filters: `not_honeypot`, `pump` |
| `fetchTrendingTokens(limit)` | `GET /tokens/trending/sol` | Ordered by `price_change_percent5m desc` |
| `fetchTokenInfo(address)` | `GET /token/sol/:address` | Single-token detail for manual buys |

Rate-limit: ~1 req/s without an API key. Auth header is added when `GMGN_API_KEY` is set.

**`TokenDiscovery`** — wraps `GmgnClient` with deduplication, polls both endpoints, and emits candidate `TokenInfo` objects into the screening pipeline.

---

### `src/screening/`

**`TokenFilter`** — evaluates every criterion from `SCREENING` config and returns `FilterResult { passed, reasons[] }`. All checks must pass; any failure is accumulated as a human-readable reason string.

| Criterion | Default | Config key |
|---|---|---|
| Market cap | $10 k – $500 k USD | `minMarketCapUsd` / `maxMarketCapUsd` |
| Liquidity | ≥ $5 k | `minLiquidityUsd` |
| 1-hour volume | ≥ $1 k | `minVolume1hUsd` |
| Token age | ≤ 60 min | `maxAgeMs` |
| Holder count | ≥ 50 | `minHolderCount` |
| Top-10 concentration | ≤ 60 % | `maxTop10HolderPercent` |
| 5-min momentum | ≥ +5 % | `minPriceChange5mPct` |
| Mint authority | revoked | `requireMintRevoked` |
| Freeze authority | revoked | `requireFreezeRevoked` |
| LP burned | ≥ 80 % | `minLpBurnedPct` |
| Dev holdings | ≤ 10 % | `maxDevHoldingPct` |

**`RugChecker`** — computes a 0–100 risk score from the same `TokenInfo`. Hard-rejects (`isRug = true`) when both mint and freeze authorities are active simultaneously.

| Flag | Score added |
|---|---|
| `MINT_NOT_REVOKED` | +40 |
| `FREEZE_NOT_REVOKED` | +30 |
| `LOW_LP_BURN` (< 50 %) | +20 |
| `PARTIAL_LP_BURN` (< 80 %) | +10 |
| `EXTREME_CONCENTRATION` (top-10 > 80 %) | +25 |
| `HIGH_CONCENTRATION` (> 60 %) | +15 |
| `HIGH_DEV_HOLDING` (> 20 %) | +20 |
| `ELEVATED_DEV_HOLDING` (> 10 %) | +10 |
| `VERY_FEW_HOLDERS` (< 30) | +15 |
| `FEW_HOLDERS` (< 100) | +5 |
| `VERY_LOW_LIQUIDITY_RATIO` (liq/mcap < 2 %) | +15 |

Tokens with a final score above `SCREENING.maxRiskScore` (default 60) are rejected before execution.

---

### `src/execution/`

**`JupiterClient`** — thin wrapper around Jupiter's v6 API.

| Method | Endpoint | Purpose |
|---|---|---|
| `getQuote(in, out, amount, slippage)` | `GET https://quote-api.jup.ag/v6/quote` | Best-route quote for a SOL↔token swap |
| `buildSwapTransaction(quote, pubkey, fee)` | `POST https://quote-api.jup.ag/v6/swap` | Returns a base64 versioned transaction ready to sign |
| `getPrice(mints[])` | `GET https://api.jup.ag/price/v2` | Batch USD price lookup (vs WSOL) used by position monitor |

All requests set `wrapAndUnwrapSol: true` and `dynamicComputeUnitLimit: true`. The swap payload embeds `prioritizationFeeLamports` for MEV protection.

**`ExecutionEngine`** — orchestrates buy/sell flows.

```
buy(tokenMint, amountSol):
  1. getWallet() — load keypair from PRIVATE_KEY
  2. getQuote(WSOL → tokenMint, lamports, buySlippageBps=300)
  3. buildSwapTransaction(quote, pubkey, priorityFee)
  4. deserializeVersionedTransaction → sign → sendAndConfirmVersionedTx
  5. return { success, txSig, tokensReceived, solSpent }

sell(tokenMint, tokenAmountRaw?):
  1. auto-fetch balance if amount omitted (getTokenBalance)
  2. getQuote(tokenMint → WSOL, rawAmount, sellSlippageBps=500)
  3. buildSwapTransaction → sign → send → confirm
  4. return { success, txSig, solSpent: -solReceived }
```

Slippage is higher on sells (500 bps vs 300 bps) to ensure exits land even in thin liquidity.

---

### `src/position/`

**`PositionManager`** — in-memory `Map<tokenAddress, Position>` with two background intervals.

**Price update loop (every 5 s)**
- Batch-fetches current USD prices via `JupiterClient.getPrice(allOpenMints)`.
- Updates `position.currentPrice` and recomputes `unrealisedPnlSol`.

**TP/SL check loop (every 5 s)**
- For each open position computes `pctChange = (current - entry) / entry * 100`.
- Triggers `closePosition(reason)` when:
  - `pctChange >= takeProfitPct` → `take_profit` (default +100 %, i.e. 2×)
  - `pctChange <= stopLossPct` → `stop_loss` (default −25 %)
  - `ageMs > positionTimeoutMs` → `timeout` (default 30 min)

**`openPosition / closePosition`** — both write to `TradeHistory` and emit to the registered `onPositionClosed` callback (used by the Telegram bot and `RiskManager`).

**Position lifecycle**
```
pending_sell ──(sell fails)──▶ open   (retry next cycle)
open ─────────────────────────▶ pending_sell ──▶ closed
```

---

### `src/risk/`

**`RiskManager`** — guards trade entry with three independent checks, all evaluated by `canTrade(openCount)`.

| Guard | Limit | Reset |
|---|---|---|
| Concurrent positions | ≤ 3 | n/a |
| Daily loss | −1.0 SOL prod / −0.1 SOL test | Midnight |
| Consecutive losses | ≥ 3 triggers 5-min cooldown | Next win |

**Position sizing** — `getPositionSizeSol()` applies a Kelly-ish reduction:
```
sizeSol = tradeAmountSol * max(0.5, 1 - consecutiveLosses * 0.1)
```
After 3+ losses the size floors at 50 % of base until the streak ends.

**`recordWin(pnl)` / `recordLoss(pnl)`** — called by the orchestrator after each position closes. Losses increment `consecutiveLosses` and stamp `lastTradeAt` for cooldown tracking.

---

### `src/telegram/`

**`TelegramBot`** — Grammy bot running in long-poll mode. Sends notifications to `TELEGRAM_CHAT_ID` via `bot.api.sendMessage`. All commands are restricted to the configured chat ID.

**Command reference**

| Command | Description |
|---|---|
| `/start` | Set mode → `autonomous`, begin sniping |
| `/stop` | Set mode → `stopped` (open positions still monitored) |
| `/mode` | Show current `autonomous \| manual \| stopped` |
| `/status` | Balance + risk state + open positions in one message |
| `/positions` | List all open positions with unrealised PnL % |
| `/pnl` | Total/daily PnL, win rate, trade count |
| `/balance` | Live wallet SOL balance |
| `/buy <addr> [sol]` | Manual buy — runs filter + rug check first |
| `/buy_force <addr>` | Manual buy skipping all filters (emergency override) |
| `/sell <addr>` | Close a tracked position at market |
| `/sell_raw <addr>` | Sell any token balance without a tracked position |
| `/help` | Command list |

**`notify(msg)`** — called by the orchestrator when a new trade is entered and when `onPositionClosed` fires. Position-close notifications include symbol, close reason, PnL in SOL, and PnL %.

---

### `src/logger/`

**`Logger`** — structured pino/winston logger writing JSON to stdout and to rotating log files. Two exported instances: `logger` (application events) and `tradeLog` (raw trade events tagged `BUY_EXECUTED` / `SELL_EXECUTED`).

**`TradeHistory`** — append-only array of `TradeRecord` persisted to `trades/history.json` on every write. Provides:

- `getAll()` — full history
- `getTodaysTrades()` — since midnight
- `getDailyPnlSol()` / `getTotalPnlSol()` — sell-side PnL sums
- `getWinRate()` — wins / total closed trades
- `getSummary()` — single formatted string for the `/pnl` command

---

## Strategy Logic

```
Every 15 s (autonomous mode only):
  candidates = fetchNewTokens(20) + fetchTrendingTokens(20)
  deduplicate by tokenAddress

  for each candidate:
    if positionManager.hasPosition(candidate.address): skip

    rugResult = RugChecker.check(candidate)
    if rugResult.isRug: log + skip

    filterResult = TokenFilter.filter(candidate)
    if not filterResult.passed: log reasons + skip

    if rugResult.score > SCREENING.maxRiskScore: skip

    { allowed, reason } = riskManager.canTrade(openCount)
    if not allowed: log reason + break loop

    sizeSol = riskManager.getPositionSizeSol()
    result = executionEngine.buy(candidate.address, sizeSol)
    if not result.success: log + continue

    positionManager.openPosition(...)
    riskManager — position count now tracked via openCount
    telegramBot.notify("Opened position: ...")

On position close (TP / SL / timeout / manual):
  riskManager.recordWin(pnl) or riskManager.recordLoss(pnl)
  tradeHistory.record(sellRecord)
  telegramBot.notifyPositionClosed(position)
```

---

## Configuration

All tunable values live in two files. No magic numbers elsewhere.

**`src/config/config.ts`** — loaded from `.env` via `dotenv`.

| Variable | Prod default | Test default |
|---|---|---|
| `tradeAmountSol` | 0.5 | 0.05 |
| `maxPositionSizeSol` | 1.0 | 0.1 |
| `takeProfitPct` | 100 (2×) | same |
| `stopLossPct` | −25 % | same |
| `maxConcurrentPositions` | 3 | same |
| `positionTimeoutMs` | 30 min | same |
| `dailyLossLimitSol` | 1.0 | 0.1 |
| `maxConsecutiveLosses` | 3 | same |
| `cooldownAfterLossMs` | 5 min | same |
| `buySlippageBps` | 300 (3 %) | same |
| `sellSlippageBps` | 500 (5 %) | same |
| `priorityFeeLamports` | 500,000 | 100,000 |

**`src/config/constants.ts`** — fixed operational constants.

| Constant | Value |
|---|---|
| `DISCOVERY_INTERVAL_MS` | 15,000 ms |
| `PRICE_UPDATE_INTERVAL_MS` | 5,000 ms |
| `POSITION_CHECK_INTERVAL_MS` | 5,000 ms |
| `TX_CONFIRM_TIMEOUT_MS` | 60,000 ms |
| `DEFAULT_SLIPPAGE_BPS` | 300 |
| `MAX_SLIPPAGE_BPS` | 1,000 |

---

## Environment Variables (`.env`)

```
# Required
PRIVATE_KEY=<base58 wallet private key>
TELEGRAM_BOT_TOKEN=<grammy bot token>
TELEGRAM_CHAT_ID=<your numeric chat id>

# Optional
RPC_ENDPOINT=https://api.mainnet-beta.solana.com
GMGN_BASE_URL=https://gmgn.ai/defi/quotation/v1
GMGN_API_KEY=<optional, removes rate limit>
NODE_ENV=test   # set to "production" for live trading
```

---

## Directory Layout

```
gmgn-sniper-bot/
├── src/
│   ├── config/
│   │   ├── config.ts          # env + strategy parameters
│   │   └── constants.ts       # polling intervals, API URLs
│   ├── discovery/
│   │   ├── GmgnClient.ts      # GMGN API wrapper
│   │   └── TokenDiscovery.ts  # polling loop + deduplication
│   ├── screening/
│   │   ├── TokenFilter.ts     # quantitative filter criteria
│   │   └── RugChecker.ts      # rug risk score (0–100)
│   ├── execution/
│   │   ├── JupiterClient.ts   # Jupiter quote / swap / price API
│   │   └── ExecutionEngine.ts # buy / sell orchestration
│   ├── position/
│   │   └── PositionManager.ts # open/close, TP/SL loops
│   ├── risk/
│   │   └── RiskManager.ts     # daily limits, cooldown, sizing
│   ├── telegram/
│   │   ├── TelegramBot.ts     # Grammy bot + notify helpers
│   │   └── commands/
│   │       └── index.ts       # command handlers
│   ├── logger/
│   │   ├── Logger.ts          # structured logger
│   │   └── TradeHistory.ts    # persistent trade record
│   ├── utils/
│   │   └── solana.ts          # wallet, balance, tx helpers
│   └── types/
│       └── index.ts           # shared TypeScript interfaces
├── trades/
│   └── history.json           # persisted trade records (auto-created)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## External API Summary

| API | Base URL | Auth |
|---|---|---|
| GMGN Quotation | `https://gmgn.ai/defi/quotation/v1` | Optional `Bearer` token |
| Jupiter Quote | `https://quote-api.jup.ag/v6/quote` | None |
| Jupiter Swap | `https://quote-api.jup.ag/v6/swap` | None |
| Jupiter Price | `https://api.jup.ag/price/v2` | None |
| Solana RPC | Configurable (default mainnet-beta) | None |
| Telegram Bot API | Grammy SDK | `TELEGRAM_BOT_TOKEN` |

---

## Capital Allocation

| Environment | Per-trade | Daily loss limit | Max concurrent |
|---|---|---|---|
| Production | 0.5 SOL | 1.0 SOL | 3 positions |
| Test | 0.05 SOL | 0.1 SOL | 3 positions |

Maximum simultaneous exposure: 1.5 SOL (prod) / 0.15 SOL (test).
