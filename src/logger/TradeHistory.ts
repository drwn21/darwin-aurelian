import fs from 'fs';
import path from 'path';
import { TradeRecord } from '../types/index.js';
import { logger } from './Logger.js';

const TRADES_FILE = path.join(process.cwd(), 'trades', 'history.json');

export class TradeHistory {
  private trades: TradeRecord[] = [];

  constructor() {
    this.ensureDir();
    this.load();
  }

  record(trade: TradeRecord): void {
    this.trades.push(trade);
    this.persist();
    logger.info('Trade recorded', {
      side: trade.side,
      token: trade.tokenSymbol,
      sol: trade.amountSol.toFixed(4),
      pnl: trade.pnlSol?.toFixed(4),
    });
  }

  getAll(): TradeRecord[] {
    return [...this.trades];
  }

  getTodaysTrades(): TradeRecord[] {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.trades.filter((t) => t.timestamp >= startOfDay.getTime());
  }

  getDailyPnlSol(): number {
    return this.getTodaysTrades()
      .filter((t) => t.side === 'sell')
      .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
  }

  getTotalPnlSol(): number {
    return this.trades
      .filter((t) => t.side === 'sell')
      .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
  }

  getWinRate(): number {
    const sells = this.trades.filter((t) => t.side === 'sell' && t.pnlSol !== undefined);
    if (sells.length === 0) return 0;
    const wins = sells.filter((t) => (t.pnlSol ?? 0) > 0);
    return wins.length / sells.length;
  }

  getSummary(): string {
    const sells = this.trades.filter((t) => t.side === 'sell');
    const totalPnl = this.getTotalPnlSol();
    const dailyPnl = this.getDailyPnlSol();
    const winRate = (this.getWinRate() * 100).toFixed(1);
    return (
      `Total trades: ${sells.length} | Win rate: ${winRate}%\n` +
      `Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL\n` +
      `Today PnL: ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(4)} SOL`
    );
  }

  private load(): void {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
        this.trades = JSON.parse(raw) as TradeRecord[];
      }
    } catch {
      logger.warn('Could not load trade history — starting fresh');
      this.trades = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
    } catch (err) {
      logger.error('Failed to persist trade history', { err });
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(TRADES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
