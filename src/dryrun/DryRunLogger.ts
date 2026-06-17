import fs from 'fs';
import path from 'path';
import { configManager } from '../config/ConfigManager.js';
import { logger } from '../logger/Logger.js';

export interface DryRunSignal {
  id: string;
  symbol: string;
  address: string;
  entryPrice: number;       // SOL per whole token at entry (tokenUSD / solUSD)
  marketCap: number;
  volume24h: number;
  holders: number;
  ageMinutes: number;
  buysSells: string;
  score: number;
  scoreBreakdown: string[];
  washTrading: boolean;
  bundlerPct: number;
  top10Pct: number;
  devHoldingPct: number;
  entryTime: number;        // unix ms
  entryTimeStr: string;     // human readable
  gmgnLink: string;
  // Virtual PnL tracking
  currentPrice?: number;
  highestPrice?: number;
  lowestPrice?: number;
  lastChecked?: number;
  virtualPnlPct?: number;
  status?: 'open' | 'tp_hit' | 'sl_hit' | 'timeout';
  // Partial-TP state — mirrors PositionManager so dry-run outcomes match what a
  // real position would have done.
  peakPrice?: number;             // highest price seen (display only)
  firstTargetHit?: boolean;       // TP reached → partial sold
  slBelowCount?: number;          // consecutive checks below soft SL
  virtualTokensRemaining?: number; // tokens still held after the partial sell
  /** Locked-in PnL% from partial sells, weighted against the original position. */
  realizedPnlPct?: number;
}

/** Compact USD formatter: $1.2M / $90K / $420 / — (never "$0K"). */
function formatUsd(n: number | undefined): string {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

/**
 * Readable SOL-denominated token price (SOL per whole token). Prices are tiny,
 * so fall back to significant figures to stay legible rather than exponential.
 */
function formatPrice(price: number | undefined): string {
  if (!price || price <= 0) return '—';
  if (price >= 1) return `◎${price.toFixed(4)}`;
  if (price >= 0.0001) return `◎${price.toFixed(6)}`;
  return `◎${price.toPrecision(2)}`;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'dry-run-signals.json');
const PNL_LOG_FILE = path.join(DATA_DIR, 'dry-run-pnl.csv');

export class DryRunLogger {
  private signals: DryRunSignal[] = [];

  constructor() {
    this.load();
  }

  /** Log a new dry run signal. Returns true if logged (new), false if duplicate. */
  logSignal(signal: Omit<DryRunSignal, 'id' | 'entryTime' | 'entryTimeStr' | 'highestPrice' | 'lowestPrice' | 'status' | 'peakPrice' | 'firstTargetHit' | 'slBelowCount' | 'virtualTokensRemaining' | 'realizedPnlPct'>): boolean {
    // Dedup: skip if already tracking this address (any status, not just open).
    // Prevents double-TP/SL notifications when a token re-enters screening
    // after its first signal was already closed.
    if (this.signals.some(s => s.address === signal.address)) {
      logger.debug('[DRY RUN] Skip duplicate', { symbol: signal.symbol, address: signal.address });
      return false;
    }

    // Max concurrent positions check
    const maxConcurrent = configManager.get().main.maxConcurrentPositions ?? 3;
    const openCount = this.signals.filter(s => s.status === 'open').length;
    if (openCount >= maxConcurrent) {
      logger.debug('[DRY RUN] Skip: max concurrent positions reached', { open: openCount, max: maxConcurrent });
      return false;
    }

    const entryTime = Date.now();
    const id = `${signal.symbol}_${entryTime}`;

    // Virtual position size in tokens: how many we'd hold if we'd bought
    // tradeAmountSol worth at the entry price (used to track partial sells).
    const tradeAmountSol = configManager.get().main.tradeAmountSol ?? 0.1;
    const estimatedTokens = signal.entryPrice > 0 ? tradeAmountSol / signal.entryPrice : 0;

    const full: DryRunSignal = {
      ...signal,
      id,
      entryTime,
      entryTimeStr: new Date(entryTime).toISOString(),
      highestPrice: signal.entryPrice,
      lowestPrice: signal.entryPrice,
      status: 'open',
      peakPrice: signal.entryPrice,
      firstTargetHit: false,
      slBelowCount: 0,
      virtualTokensRemaining: estimatedTokens,
      realizedPnlPct: 0,
    };

    this.signals.push(full);
    this.save();

    // CSV auto-synced on save()

    logger.info('[DRY RUN] Signal logged', {
      id,
      symbol: signal.symbol,
      price: signal.entryPrice,
      score: signal.score,
    });
    return true;
  }

  /**
   * Update virtual PnL for all open signals, replicating PositionManager's
   * combined partial-TP + trailing logic so dry-run outcomes match real:
   *   - TP: partial sell `firstTargetSellPct`% at `takeProfitPct`, activate trailing
   *   - Trailing: close remainder when price drops `trailingStopPct`% from peak
   *   - Hard SL `hardStopLossPct`% → sl_hit (immediate, no grace)
   *   - Soft SL `stopLossPct`% → sl_hit (after grace + confirms)
   *   - Timeout for flat/losing positions (green positions run)
   */
  updatePrices(priceMap: Map<string, number>, metaMap?: Map<string, { marketCap?: number; volume24h?: number }>): { tpHits: DryRunSignal[]; slHits: DryRunSignal[] } {
    const tpHits: DryRunSignal[] = [];
    const slHits: DryRunSignal[] = [];
    const now = Date.now();

    // Read all thresholds live from the runtime config
    const cfg = configManager.get();
    const takeProfitPct = cfg.strategy.takeProfitPct ?? 50;
    const firstTargetSellPct = cfg.strategy.firstTargetSellPct ?? 50;
    const trailingStopPct = cfg.strategy.trailingStopPct ?? 10;
    const useTrailingStop = cfg.strategy.useTrailingStop ?? true;
    const stopLossPct = cfg.strategy.stopLossPct ?? -20;
    const hardStopLossPct = cfg.strategy.hardStopLossPct ?? -30;
    const slGracePeriodMs = cfg.strategy.slGracePeriodMs ?? 120_000;
    const slConfirms = cfg.strategy.slConfirms ?? 2;
    const timeoutMs = cfg.strategy.positionTimeoutMs ?? 4 * 60 * 60 * 1000;

    // Fraction of the position sold at TP1.
    const f1 = firstTargetSellPct / 100;

    for (const signal of this.signals) {
      if (signal.status !== 'open') continue;

      // Force-close zombies with no usable entry data — runs regardless of
      // price availability so a bad-data signal closes immediately even when
      // GMGN never returns a live price (otherwise it lingers until timeout).
      if (signal.entryTime <= 0) {
        signal.status = 'timeout';
        signal.virtualPnlPct = 0;
        logger.info('[DRY RUN] Timeout (no entryTime)', { symbol: signal.symbol });
        continue;
      }
      if (signal.entryPrice <= 0) {
        signal.status = 'timeout';
        signal.virtualPnlPct = 0;
        logger.info('[DRY RUN] Timeout (entryPrice=0)', { symbol: signal.symbol });
        continue;
      }

      const ageMs = now - signal.entryTime;
      const currentPrice = priceMap.get(signal.address);

      // No live price this tick — still advance the age-based timeout so a
      // token GMGN stops pricing doesn't linger forever.
      if (!currentPrice) {
        if (ageMs > timeoutMs) {
          signal.status = 'timeout';
          signal.virtualPnlPct = signal.virtualPnlPct ?? 0;
          logger.info('[DRY RUN] Timeout', { symbol: signal.symbol, pnl: `${(signal.virtualPnlPct).toFixed(1)}%` });
        }
        continue;
      }

      // Update price + peak tracking
      signal.currentPrice = currentPrice;
      signal.lastChecked = now;
      if (currentPrice > (signal.highestPrice ?? 0)) signal.highestPrice = currentPrice;
      if (currentPrice < (signal.lowestPrice ?? Infinity)) signal.lowestPrice = currentPrice;
      if (currentPrice > (signal.peakPrice ?? signal.entryPrice)) signal.peakPrice = currentPrice;

      // Update MC + volume from live GMGN data
      if (metaMap) {
        const meta = metaMap.get(signal.address);
        if (meta) {
          if (meta.marketCap && meta.marketCap > 0) signal.marketCap = meta.marketCap;
          if (meta.volume24h && meta.volume24h > 0) signal.volume24h = meta.volume24h;
        }
      }

      const pctChange = ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100;
      const inGrace = ageMs < slGracePeriodMs;

      // Fraction of the original position still held
      const remainingFraction = signal.firstTargetHit ? (1 - f1) : 1;
      // Blended mark: locked-in profit + live mark on the remainder
      signal.virtualPnlPct = (signal.realizedPnlPct ?? 0) + remainingFraction * pctChange;

      // Hard SL — immediate, no grace
      if (pctChange <= hardStopLossPct) {
        signal.status = 'sl_hit';
        slHits.push(signal);
        logger.info('[DRY RUN] Hard SL hit', { symbol: signal.symbol, pnl: `${signal.virtualPnlPct.toFixed(1)}%` });
        continue;
      }

      // Soft SL — after grace, needs confirmation
      if (!inGrace) {
        if (pctChange <= stopLossPct) {
          signal.slBelowCount = (signal.slBelowCount ?? 0) + 1;
          if (signal.slBelowCount >= slConfirms) {
            signal.status = 'sl_hit';
            slHits.push(signal);
            logger.info('[DRY RUN] SL hit', { symbol: signal.symbol, pnl: `${signal.virtualPnlPct.toFixed(1)}%`, confirms: signal.slBelowCount });
            continue;
          }
        } else {
          signal.slBelowCount = 0; // reset if recovered
        }
      }

      // Timeout — only force-close flat/losing positions
      if (ageMs > timeoutMs && pctChange <= 0) {
        signal.status = 'timeout';
        logger.info('[DRY RUN] Timeout', { symbol: signal.symbol, pnl: `${signal.virtualPnlPct.toFixed(1)}%`, ageMin: Math.round(ageMs / 60_000) });
        continue;
      }

      // TP: partial sell + activate trailing
      if (!signal.firstTargetHit) {
        if (pctChange >= takeProfitPct) {
          signal.firstTargetHit = true;
          const sellTokens = Math.floor((signal.virtualTokensRemaining ?? 0) * f1);
          signal.virtualTokensRemaining = (signal.virtualTokensRemaining ?? 0) - sellTokens;
          signal.realizedPnlPct = (signal.realizedPnlPct ?? 0) + f1 * pctChange;
          signal.virtualPnlPct = signal.realizedPnlPct + (1 - f1) * pctChange;
          logger.info('[DRY RUN] TP partial', { symbol: signal.symbol, pct: pctChange.toFixed(1), sellPct: firstTargetSellPct });
        }
      }

      // Trailing TP: close if drops trailingStopPct% from peak
      if (useTrailingStop && signal.firstTargetHit && signal.peakPrice && signal.peakPrice > 0) {
        const dropFromPeak = ((signal.peakPrice - currentPrice) / signal.peakPrice) * 100;
        if (dropFromPeak >= trailingStopPct) {
          signal.status = 'tp_hit';
          tpHits.push(signal);
          logger.info('[DRY RUN] Trailing TP hit', { symbol: signal.symbol, pnl: `${signal.virtualPnlPct.toFixed(1)}%`, drop: dropFromPeak.toFixed(1) });
          continue;
        }
      }
    }

    this.save();
    return { tpHits, slHits };
  }

  /** Get all open signals */
  getOpenSignals(): DryRunSignal[] {
    return this.signals.filter(s => s.status === 'open');
  }

  /** Get all signals */
  getAllSignals(): DryRunSignal[] {
    return [...this.signals];
  }

  /** Get summary stats */
  getSummary(): { total: number; open: number; tpHits: number; slHits: number; timeouts: number; winRate: number; avgPnl: number; totalPnlPct: number; totalPnlSol: number } {
    const cfg = configManager.get();
    const closed = this.signals.filter(s => s.status !== 'open');
    const tpHits = closed.filter(s => s.status === 'tp_hit').length;
    const slHits = closed.filter(s => s.status === 'sl_hit').length;
    const timeouts = closed.filter(s => s.status === 'timeout').length;
    const wins = closed.filter(s => s.status === 'tp_hit' || (s.status === 'timeout' && (s.virtualPnlPct ?? 0) > 0)).length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const pnls = closed.map(s => s.virtualPnlPct ?? 0);
    const avgPnl = pnls.length > 0
      ? pnls.reduce((sum, p) => sum + p, 0) / pnls.length
      : 0;
    const totalPnlPct = pnls.reduce((sum, p) => sum + p, 0);

    // Each trade is tradeAmountSol from runtime config.
    const tradeSizeSol = cfg.main.tradeAmountSol ?? 0.1;
    const totalPnlSol = closed.reduce((sum, s) => {
      const pct = s.virtualPnlPct ?? 0;
      return sum + (pct / 100) * tradeSizeSol;
    }, 0);

    return {
      total: this.signals.length,
      open: this.signals.filter(s => s.status === 'open').length,
      tpHits,
      slHits,
      timeouts,
      winRate,
      avgPnl,
      totalPnlPct,
      totalPnlSol,
    };
  }

  /** Format summary for Telegram */
  formatSummary(): string {
    const s = this.getSummary();
    const open = this.signals.filter(s => s.status === 'open');
    const closed = this.signals.filter(s => s.status !== 'open');

    // Sanitize symbol for Telegram Markdown (strip *, _, etc.)
    const safe = (sym: string) => sym.replace(/[*_\[\]()~`>#+=|{}.!\\-]/g, '');

    let msg = `📊 *Dry Run Summary*\n\n`;

    // Overview
    msg += `Signals: ${s.total} | Open: ${s.open} | Closed: ${closed.length}\n`;
    if (closed.length > 0) {
      msg += `TP: ${s.tpHits} | SL: ${s.slHits} | Timeout: ${s.timeouts}\n`;
      msg += `Win rate: ${s.winRate.toFixed(0)}% | Avg PnL: ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(1)}%\n`;
      const sign = s.totalPnlSol >= 0 ? '+' : '';
      msg += `Total PnL: ${sign}${s.totalPnlSol.toFixed(4)} SOL (${sign}${s.totalPnlPct.toFixed(1)}%)\n`;
    }
    msg += `\n`;

    // Open positions with live PnL — one header line + an indented price line
    // so each signal shows symbol, PnL%, age, MC and its high/low prices.
    if (open.length > 0) {
      msg += `📈 *Open Positions (${open.length}):*\n`;
      for (const r of open) {
        const pnl = r.virtualPnlPct ?? 0;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        const sign = pnl >= 0 ? '+' : '';
        const age = r.entryTime ? Math.floor((Date.now() - r.entryTime) / 60000) : 0;
        const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h${age % 60}m`;
        const mcapStr = formatUsd(r.marketCap);
        const mcapSolStr = r.marketCap && configManager.solPriceUsd > 0
          ? `◎${(r.marketCap / configManager.solPriceUsd).toFixed(0)}`
          : '—';

        const high = r.highestPrice ?? r.entryPrice;
        const low = r.lowestPrice ?? r.entryPrice;
        const now = r.currentPrice ?? r.entryPrice;
        const peak = r.peakPrice ?? high;

        // Scale-out badge: 🎯 once TP1 has partially sold and we ride to TP2.
        const badge = r.firstTargetHit ? ' 🎯 TP1' : '';

        msg += `${emoji} *${safe(r.symbol)}* ${sign}${pnl.toFixed(1)}%${badge} | ${ageStr} | MC ${mcapStr}/${mcapSolStr}\n`;
        msg += `   ▲ ${formatPrice(high)}  ▼ ${formatPrice(low)}  •  now ${formatPrice(now)}  •  peak ${formatPrice(peak)}\n`;
      }
    }

    // Closed positions — show the most recent 15 (newest first) with a clear
    // per-outcome icon, and note how many older ones are hidden so the operator
    // knows the list is truncated rather than complete.
    if (closed.length > 0) {
      const MAX_SHOWN = 15;
      const shown = closed.slice(-MAX_SHOWN).reverse();
      const hidden = closed.length - shown.length;

      const icon = (status: DryRunSignal['status']): string => {
        if (status === 'tp_hit') return '🟢 TP';
        if (status === 'sl_hit') return '🔴 SL';
        return '⏱️ TO'; // timeout
      };

      msg += `\n📋 *Closed (${closed.length})`;
      msg += hidden > 0 ? ` — newest ${shown.length}:*\n` : `:*\n`;
      for (const r of shown) {
        const pnl = r.virtualPnlPct ?? 0;
        const sign = pnl >= 0 ? '+' : '';
        msg += `${icon(r.status)}  ${safe(r.symbol)}  ${sign}${pnl.toFixed(1)}%\n`;
      }
      if (hidden > 0) {
        msg += `…and ${hidden} older (full history in data/dry-run-pnl.csv)\n`;
      }
    }

    return msg;
  }

  private load(): void {
    try {
      if (fs.existsSync(SIGNALS_FILE)) {
        this.signals = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf-8'));
        // Auto-close open signals from PREVIOUS sessions (older than 1 hour).
        // Keeps recent signals alive across bot restarts so the user can see them.
        let closed = 0;
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        for (const s of this.signals) {
          if (s.status === 'open' && s.entryTime && s.entryTime < oneHourAgo) {
            s.status = 'timeout';
            s.virtualPnlPct = s.virtualPnlPct ?? 0;
            closed++;
          }
        }
        if (closed > 0) this.save();
        logger.info('[DRY RUN] Loaded signals', { count: this.signals.length, autoClosed: closed });
      }
    } catch (err) {
      logger.warn('[DRY RUN] Could not load signals file', { err: String(err) });
      this.signals = [];
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SIGNALS_FILE, JSON.stringify(this.signals, null, 2));
      this.syncCsv();
    } catch (err) {
      logger.error('[DRY RUN] Failed to save signals', { err: String(err) });
    }
  }

  /** Regenerate the full CSV from current signals (keeps PnL/status up to date). */
  private syncCsv(): void {
    try {
      const header = 'id,symbol,address,entry_price,exit_price,market_cap,volume,holders,age_min,buys_sells,score,wash_trading,bundler_pct,top10_pct,dev_holding_pct,entry_time,status,pnl_pct\n';
      const lines = [header];
      for (const s of this.signals) {
        const row = [
          s.id,
          s.symbol,
          s.address,
          s.entryPrice,
          s.currentPrice ?? '',
          s.marketCap,
          s.volume24h,
          s.holders,
          s.ageMinutes,
          s.buysSells,
          s.score,
          s.washTrading,
          s.bundlerPct,
          s.top10Pct,
          s.devHoldingPct,
          s.entryTimeStr,
          s.status ?? '',
          (s.virtualPnlPct ?? 0).toFixed(2),
        ].join(',');
        lines.push(row + '\n');
      }
      fs.writeFileSync(PNL_LOG_FILE, lines.join(''));
    } catch (err) {
      logger.error('[DRY RUN] Failed to sync CSV', { err: String(err) });
    }
  }
}
