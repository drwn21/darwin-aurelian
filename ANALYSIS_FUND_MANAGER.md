# Aurelian Bot — Fund Manager Critical Analysis
## Date: 2026-06-22 | Analyst: Professional Crypto Fund Manager

---

## EXECUTIVE SUMMARY

The bot is **losing money despite a near-50% win rate** because the math doesn't work: average win (+12.7%) is far smaller than average loss (-19.3%), and transaction costs consume ~37% of each trade. The strategy is structurally broken — it needs to be profitable on ~65%+ of trades just to break even at current cost structure. The velocity dump feature is actively destroying value by panic-selling at local bottoms during normal Pump.fun volatility.

**Bottom line: This bot would blow up a $100K fund within weeks.** However, with the changes below, it can become viable.

---

## CRITICAL FINDINGS (Ranked by Impact)

### 🔴 1. REMOVE VELOCITY DUMP ENTIRELY (Impact: +3-5% win rate, stops destroying winners)

**Location:** `PositionManager.ts` lines 497-532

**The Problem:**
- Price updates every 5 seconds
- Tracks last 3 readings
- If ANY consecutive reading shows >10% drop → emergency sell
- 30-second cooldown after entry (line 508) — but 30s is way too short
- **Bypasses ALL safety mechanisms**: grace period, SL confirms, selling lock
- On Pump.fun, 10-20% dips in seconds are **normal market microstructure**, not crashes
- Tokens routinely dip 15% then pump 100%+ within minutes
- The feature **guarantees selling at the local bottom** — the worst possible exit

**The .jpeg Incident Analysis:**
- Bought at 19:50
- Within 20 seconds, a >10% drop was detected between two 5-second price readings
- Emergency sold at -18.8% loss
- Token then rebounded and pumped
- **This is not a bug — it's the feature working as designed. The design is wrong.**

**Verdict: DELETE the entire velocity dump feature. It has negative expected value.**

The existing protections (SL -15% with grace, hard SL -15%, price fail dark detection, bundler dump detection, rug signal detection) are MORE than sufficient to protect against genuine crashes.

---

### 🔴 2. TRANSACTION COSTS ARE KILLING THE STRATEGY (Impact: +15-20% PnL improvement)

**Current cost structure per round-trip:**
- Buy slippage: 1000 bps (10%) — EXTREMELY HIGH
- Sell slippage: 2000 bps (20%) — CATASTROPHICALLY HIGH
- Priority fee: 200,000 lamports × 2 = ~0.0004 SOL per round-trip
- Jupiter platform fee
- **Total round-trip cost: ~30-37% of position**

**What this means:**
- A trade must gain +35-40% just to BREAK EVEN
- With TP at +30%, many "winning" trades are actually net-negative after costs
- The bot is literally paying more in costs than it makes in profit

**Fixes:**
- Reduce `buySlippageBps` from 1000 → **300** (3%) — Pump.fun bonding curve tokens have tight spreads
- Reduce `sellSlippageBps` from 2000 → **500** (5%) — still generous for exits
- Reduce `priorityFeeLamports` from 200000 → **100000** — most txs don't need 0.0002 SOL priority
- **Expected impact: Round-trip costs drop from ~37% to ~10-12%**

---

### 🔴 3. HARD SL AND SOFT SL ARE IDENTICAL — GRACE PERIOD IS WORTHLESS (Impact: +2-3% win rate)

**Current config:**
- `stopLossPct`: -15% (soft, needs 2 confirms after grace period)
- `hardStopLossPct`: -15% (fires immediately, no grace)

**The Problem:**
- Both trigger at the same -15% level
- Hard SL fires FIRST (line 586-590 in checkTPSL) — it has NO grace period
- The soft SL with grace period (60s) and confirms (2) is **completely dead code**
- New positions get stopped out on normal Pump.fun dips within seconds of entry

**Fix:**
- `hardStopLossPct`: **-30%** (genuine crash protection only)
- `stopLossPct`: **-20%** (with grace period and confirms)
- `slGracePeriodMs`: **120000** (2 minutes — let the position breathe)
- `slConfirms`: **3** (require 3 consecutive readings below SL)

**This gives Pump.fun tokens room to show their natural volatility before cutting.**

---

### 🔴 4. TRAILING STOP IS TOO TIGHT — CUTS WINNERS SHORT (Impact: +3-5% avg win)

**Current:** `trailingStopPct: 10` (sells when price drops 10% from peak after TP hit)

**The Problem:**
- Average win is only +12.7% despite TP being set at +30%
- This means most wins hit the trailing stop at ~+12-15% rather than the TP
- The trailing stop is so tight it captures almost none of the upside after TP hit
- On Pump.fun, 10% retracements from peaks are constant and normal

**Fix:**
- `trailingStopPct`: **20** (allow 20% retracement from peak)
- `firstTargetSellPct`: **40** (sell 40% at TP, keep 60% running with trailing)
- This lets winners run while still locking in partial profit

---

### 🟡 5. POSITION SIZE TOO SMALL FOR COST STRUCTURE (Impact: +2-3% efficiency)

**Current:** 0.015 SOL per trade (~$2.25)

**The Problem:**
- Fixed costs (priority fees, rent reclaim) are proportionally massive at this size
- 0.0004 SOL priority fees on 0.015 SOL = 2.67% just in priority fees
- The 0.002 SOL rent reclaim helps but isn't enough
- At this size, you're essentially paying retail prices for institutional execution

**Fix:**
- Increase to **0.05 SOL** per trade (~$7.50)
- Max 3 concurrent = 0.15 SOL total exposure (still very conservative)
- Fixed costs become proportionally smaller
- OR: Keep 0.015 SOL but reduce priority fees to 50,000 lamports

---

### 🟡 6. NO ADAPTIVE STRATEGY BASED ON MARKET CONDITIONS (Impact: +2-4% win rate)

**Missing features that would significantly improve performance:**

**A. Volume-weighted entry timing:**
- Don't buy tokens that are in a volume drought
- Prefer tokens with increasing volume over the last 5 minutes

**B. Momentum confirmation before entry:**
- Require 2-3 consecutive positive price readings before buying
- Currently the bot buys on first signal — could be buying a dead-cat bounce

**C. Smart money flow post-entry:**
- Monitor if smart degen wallets are still buying after your entry
- If they're selling, tighten stops

**D. Time-of-day awareness:**
- Pump.fun has activity cycles (US hours = highest volume)
- Reduce position size during low-volume hours

**E. Win rate adaptive sizing:**
- If recent win rate drops below 40%, reduce position size by 50%
- If recent win rate is above 60%, increase position size by 25%

---

### 🟡 7. SCREENING FILTER GAPS (Impact: +1-2% win rate)

**Issues found in TokenFilter.ts:**

**A. Price change filters are too permissive:**
- `minPriceChange5mPct`: -5% — allows tokens already dumping
- `maxPriceChange1hPct`: 80% — allows tokens that already pumped (buying the top)
- Fix: `minPriceChange5mPct`: **0** (only buy tokens with positive recent momentum)
- Fix: `maxPriceChange1hPct`: **50** (don't buy tokens that already 2x'd)

**B. Volume spike detection is disabled:**
- `volumeSpikeRatio()` always returns 1 (line 358-362 in TokenFilter.ts)
- Comment says "GMGN rank API doesn't expose volume_1h"
- This removes a key quality signal from the composite score
- Fix: Implement using price change as proxy, or use 5m volume if available

**C. Composite score threshold may be wrong:**
- `minCompositeScore`: 70
- Need to verify what the average score of winning vs losing trades is
- If winners average 75 and losers average 72, the threshold is meaningless

---

### 🟡 8. RACE CONDITION: VELOCITY DUMP DURING SELL (Impact: Edge case)

**In PositionManager.ts line 521:**
```typescript
if (!pos.selling) {
  pos.selling = true;
  try {
    await this.performClose(pos, pos.tokenAddress, 'velocity_dump', ...);
  } finally {
    pos.selling = false;
  }
}
```

**The Problem:**
- The velocity dump check runs in `updatePrices()` (every 5 seconds)
- The TP/SL check runs in `checkTPSL()` (every 5 seconds)
- Both can trigger simultaneously if a sharp drop hits TP/SL thresholds AND velocity dump threshold
- The `pos.selling` flag prevents double-sells, BUT velocity dump sets it directly
- If velocity dump is mid-sell and TP/SL fires, it skips (correct)
- But if TP/SL is mid-sell and velocity dump fires, it ALSO skips (correct)
- **This specific race condition is handled correctly** — no bug here

**However:** The velocity dump calling `performClose` directly (bypassing `closePosition`) means the close handler (`onClose`) is still called, so risk tracking works. This is fine.

---

### 🟢 9. ENTRY STRATEGY IS MOSTLY SOUND (Keep)

**What's working:**
- RugChecker with on-chain authority verification
- Anti-honeypot sell-back simulation
- Pre-execution price recheck via Jupiter
- GMGN safety flags (honeypot, wash trading, bundler rate)
- Theme cohort blocking after trades
- Recently traded cooldown (2 hours)

**Minor improvements:**
- The `canSellBackMinAgeMs: 7200000` (2 hours) is too long
- If a sell fails on a young position, waiting 2 hours to retry is excessive
- Fix: Reduce to **300000** (5 minutes)

---

## CONFIG CHANGES (Ordered by Impact)

### Phase 1: Emergency Fixes (Do Today)

```json
{
  "strategy": {
    "buySlippageBps": 300,
    "sellSlippageBps": 500,
    "priorityFeeLamports": 100000,
    "hardStopLossPct": -30,
    "stopLossPct": -20,
    "slGracePeriodMs": 120000,
    "slConfirms": 3,
    "trailingStopPct": 20,
    "firstTargetSellPct": 40,
    "canSellBackMinAgeMs": 300000
  }
}
```

### Phase 2: Code Changes (This Week)

1. **DELETE velocity dump feature entirely** from PositionManager.ts
   - Remove lines 497-532 (velocity dump detection)
   - Remove `priceReadings` Map and `VELOCITY_HISTORY_SIZE`
   - Remove `'velocity_dump'` from CloseReason type
   - Remove from `NEGATIVE_REASONS` set in index.ts

2. **Increase default position size** to 0.05 SOL

3. **Add volume confirmation** to entry strategy

### Phase 3: Strategic Enhancements (Next Sprint)

1. Implement adaptive position sizing based on recent win rate
2. Add time-of-day awareness
3. Re-enable volume spike detection in scoring
4. Add smart money flow monitoring post-entry

---

## EXPECTED OUTCOMES AFTER FIXES

| Metric | Current | After Phase 1 | After Phase 2 |
|--------|---------|---------------|---------------|
| Win Rate | 48.9% | 52-55% | 55-60% |
| Avg Win | +12.7% | +18-22% | +20-25% |
| Avg Loss | -19.3% | -15-17% | -14-16% |
| Round-trip Cost | ~37% | ~10-12% | ~10-12% |
| Net PnL (45 trades) | -0.032 SOL | +0.08-0.12 SOL | +0.12-0.18 SOL |

---

## IS THE STRATEGY FUNDAMENTALLY VIABLE?

**Yes, with conditions.**

The core idea (early momentum on Pump.fun $10K-$150K MC tokens) is sound and has edge in the market. The problems are:

1. **Execution costs** are destroying the edge (fixable)
2. **Exit strategy** is poorly calibrated for Pump.fun volatility (fixable)
3. **Velocity dump** is actively harmful (removable)
4. **Position sizing** is too small for the cost structure (adjustable)

**The strategy is NOT viable if:**
- Transaction costs remain above 15% round-trip
- The velocity dump feature stays enabled
- SL/TP ratios remain asymmetric (avg loss > avg win)
- Position size stays at 0.015 SOL with current priority fees

**With a $100K fund, I would:**
1. Make the Phase 1 config changes immediately
2. Run 100 trades in dry-run with the new settings
3. Only go live if dry-run shows >55% win rate and positive expected value
4. Start with 0.1 SOL position size (0.3 SOL max exposure)
5. Scale to 0.5 SOL per trade only after 200 profitable live trades

---

## APPENDIX: VELOCITY DUMP DEEP DIVE

### Why It Exists (Developer Intent)
The velocity dump was likely added to catch "flash crashes" where a token's price drops 50%+ in seconds (rug pulls, LP removal). The intent is valid.

### Why It Fails in Practice
1. **10% threshold is too low** for Pump.fun — normal volatility exceeds this constantly
2. **5-second sampling** is too coarse — a single wick can trigger it
3. **No volume confirmation** — a price drop on 0 volume is meaningless
4. **Bypasses all safety** — grace period, confirms, selling lock
5. **Guarantees worst exit** — sells at the bottom of every dip

### If You MUST Keep Some Form of It
Replace with a "crash detector" that:
- Requires >30% drop (not 10%)
- Requires volume spike (confirms real selling, not just a wick)
- Requires 2 consecutive readings (10 seconds) at the lower price
- Does NOT bypass grace period
- Logs a warning but doesn't auto-sell — alerts the operator instead

### Recommended Replacement: None
The existing protections are sufficient:
- Hard SL at -30% catches genuine crashes
- Price fail dark detection catches dead tokens
- Bundler dump detection catches coordinated sells
- Rug signal detection catches rug pulls
- Liquidity monitoring catches LP removal

**Velocity dump is redundant with better systems already in place.**
