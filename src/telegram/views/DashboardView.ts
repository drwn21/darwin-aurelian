import { Bot, Context, InlineKeyboard } from 'grammy';
import { PositionManager } from '../../position/PositionManager.js';
import { RiskManager } from '../../risk/RiskManager.js';
import { TradeHistory } from '../../logger/TradeHistory.js';
import { DryRunLogger } from '../../dryrun/DryRunLogger.js';
import { STRATEGY, SCREENING } from '../../config/config.js';
import { BotMode } from '../../types/index.js';
import { configManager } from '../../config/ConfigManager.js';
import { ConfigPanel } from '../config/ConfigPanel.js';
import { logger } from '../../logger/Logger.js';

interface DashboardDeps {
  positionManager: PositionManager;
  riskManager: RiskManager;
  tradeHistory: TradeHistory;
  dryRunLogger: DryRunLogger;
  configPanel: ConfigPanel;
  getMode: () => BotMode;
  setMode: (m: BotMode) => void;
}

/**
 * Main dashboard with inline keyboard — first thing the user sees on /start.
 * Mirrors GNGM Screener style: status panel + button grid.
 */
export class DashboardView {
  constructor(private deps: DashboardDeps) {}

  register(bot: Bot<Context>): void {
    // /start — show dashboard
    bot.command('start', (ctx) => {
      this.deps.setMode('autonomous');
      logger.info('Autonomous mode started via Telegram');
      this.showDashboard(ctx, true);
    });

    // /stop
    bot.command('stop', (ctx) => {
      this.deps.setMode('stopped');
      logger.info('Bot stopped via Telegram');
      ctx.reply('Bot stopped. Open positions will continue to be monitored for TP/SL.');
    });

    // Callback: main dashboard buttons
    bot.callbackQuery(/^dash:/, async (ctx) => {
      try {
        await this.handleCallback(ctx);
      } catch (err) {
        logger.warn('Dashboard callback failed', { data: ctx.callbackQuery.data, err: String(err) });
        await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => undefined);
      }
    });
  }

  /** Show the main dashboard */
  async showDashboard(ctx: Context, forceReply = false): Promise<void> {
    const text = this.formatDashboard();
    const keyboard = this.buildDashboardKeyboard();

    if (!forceReply) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        return;
      } catch (err: any) {
        // "message is not modified" = same content, just ignore
        if (err?.description?.includes('not modified')) return;
        // Other edit errors = fall through to reply
      }
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(() => undefined);
  }

  /** Format dashboard status panel */
  private formatDashboard(): string {
    const mode = this.deps.getMode();
    const positions = this.deps.positionManager.getOpenPositions();
    const dryRunSignals = this.deps.dryRunLogger.getOpenSignals();
    const isProd = configManager.isProduction();
    const cfg = configManager.get();

    const posCount = configManager.isDryRun() ? dryRunSignals.length : positions.length;
    const maxPos = cfg.main.maxConcurrentPositions ?? STRATEGY.maxConcurrentPositions;
    const tradeAmt = cfg.main.tradeAmountSol ?? STRATEGY.tradeAmountSol;
    const modeStr = mode === 'autonomous' ? '✅ ON' : '❌ OFF';

    let text = '';
    text += `*GMGN Sniper Bot* ${isProd ? '(PROD)' : '(TEST)'}\n\n`;
    text += `📊 Positions: ${posCount}/${maxPos}\n`;
    text += `🤖 Auto-Trade: ${modeStr}`;
    if (configManager.isDryRun()) text += ` (DRY RUN)`;
    text += `\n`;
    const tpPct = cfg.strategy.takeProfitPct ?? STRATEGY.takeProfitPct;
    const sellPct = cfg.strategy.firstTargetSellPct ?? STRATEGY.firstTargetSellPct;
    const trailPct = cfg.strategy.trailingStopPct ?? STRATEGY.trailingStopPct;
    const slPct = cfg.strategy.stopLossPct ?? STRATEGY.stopLossPct;
    const hardSlPct = cfg.strategy.hardStopLossPct ?? STRATEGY.hardStopLossPct;

    text += `💰 Buy: ${tradeAmt} SOL | 🔴 SL: ${slPct}%\n`;
    text += `📈 TP: +${tpPct}% (sell ${sellPct}%, trail ${trailPct}%) | SL: ${slPct}% (hard ${hardSlPct}%)\n`;
    const minMc = cfg.screening?.minMarketCapUsd ?? SCREENING.minMarketCapUsd;
    const maxMc = cfg.screening?.maxMarketCapUsd ?? SCREENING.maxMarketCapUsd;
    text += `🎯 MC: $${(minMc / 1000).toFixed(0)}K-$${(maxMc / 1000).toFixed(0)}K`;
    const minVol = cfg.screening?.minVolume24hUsd;
    if (minVol) text += ` | Vol: $${(minVol / 1000).toFixed(0)}K+`;
    const maxBundler = cfg.screening?.maxBundlerRate;
    if (maxBundler != null && maxBundler < 1) text += ` | Bundler: <${(maxBundler * 100).toFixed(0)}%`;
    const maxEntrap = cfg.screening?.maxEntrapmentRatio;
    if (maxEntrap != null && maxEntrap < 1) text += ` | Entrap: <${(maxEntrap * 100).toFixed(0)}%`;
    text += `\n`;
    const min5m = cfg.screening?.minPriceChange5mPct;
    const max5m = cfg.screening?.maxPriceChange5mPct;
    const max1h = cfg.screening?.maxPriceChange1hPct;
    if (min5m != null || max5m != null || max1h != null) {
      text += `📊 5m: ${min5m ?? '?'}%~${max5m ?? '?'}%`;
      if (max1h != null) text += ` | 1h: <${max1h}%`;
      text += `\n`;
    }
    text += `\nSelect option:`;

    return text;
  }

  /** Build main dashboard inline keyboard */
  private buildDashboardKeyboard(): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Row 1: main views
    kb.text('📊 Positions', 'dash:positions')
      .text('📈 PNL', 'dash:pnl')
      .text('⚙️ Config', 'dash:config')
      .row();

    // Row 2: utilities
    kb.text('💼 Wallet', 'dash:wallet')
      .text('🔄 Refresh', 'dash:refresh')
      .text('📋 Dry Run', 'dash:dryrun')
      .row();

    // Row 3: toggle
    const mode = this.deps.getMode();
    if (mode === 'autonomous') {
      kb.text('⏸ Stop', 'dash:stop');
    } else {
      kb.text('▶ Start', 'dash:start');
    }

    return kb;
  }

  /** Handle dashboard button callbacks */
  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const action = data.split(':')[1];

    switch (action) {
      case 'refresh': {
        await this.showDashboard(ctx);
        await ctx.answerCallbackQuery({ text: 'Refreshed' });
        break;
      }

      case 'positions': {
        if (configManager.isDryRun()) {
          await this.showDryRunPositions(ctx);
        } else {
          await this.showRealPositions(ctx);
        }
        await ctx.answerCallbackQuery();
        break;
      }

      case 'pnl': {
        const open = this.deps.positionManager.getOpenPositions();
        const openPnl = open.reduce((sum, pos) => {
          const pnl = (pos.currentPrice - pos.entryPrice) / pos.entryPrice * pos.entryAmountSol;
          return sum + pnl;
        }, 0);

        const summary = this.deps.tradeHistory.getSummary();
        const recent = this.deps.tradeHistory.getRecentSells(10);

        let detail = '';
        if (recent.length > 0) {
          detail = '\n📋 Recent (last 10):\n';
          for (const t of recent.slice().reverse()) {
            const pnl = t.pnlSol ?? 0;
            const pnlPct = t.pnlPct ?? 0;
            const emoji = pnl >= 0 ? '🟢' : '🔴';
            const sign = pnl >= 0 ? '+' : '';
            const reason = t.closeReason ? ` ${t.closeReason.replace(/_/g, ' ')}` : '';
            detail += `${emoji} ${t.tokenSymbol}: ${sign}${pnl.toFixed(6)} SOL (${sign}${pnlPct.toFixed(1)}%)${reason}\n`;
          }
        }

        const kb = new InlineKeyboard().text('🔄 Refresh', 'dash:pnl').row().text('« Back', 'dash:back');
        const modeStr = configManager.isDryRun() ? 'DRY RUN' : 'LIVE';
        await ctx.editMessageText(
          `*🔴 PNL Summary — ${modeStr}*\n\n` +
          `📈 Open: ${open.length} positions\n` +
          `💰 Open PNL: ${openPnl >= 0 ? '+' : ''}${openPnl.toFixed(4)} SOL\n\n` +
          summary + '\n' + detail,
          { parse_mode: 'Markdown', reply_markup: kb },
        ).catch(() => undefined);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'config': {
        // Open the real settings panel in place (handles its own answerCallbackQuery).
        await this.deps.configPanel.open(ctx);
        break;
      }

      case 'wallet': {
        const { getWalletBalanceSol } = await import('../../utils/solana.js');
        const bal = await getWalletBalanceSol().catch(() => 0);
        const kb = new InlineKeyboard().text('« Back', 'dash:back');
        await ctx.editMessageText(`*Wallet*\n\nBalance: *${bal.toFixed(4)} SOL*`, {
          parse_mode: 'Markdown',
          reply_markup: kb,
        }).catch(() => undefined);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'dryrun': {
        const msg = this.deps.dryRunLogger.formatSummary();
        const kb = new InlineKeyboard().text('« Back', 'dash:back');
        await ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          reply_markup: kb,
        }).catch(() => undefined);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'start': {
        this.deps.setMode('autonomous');
        logger.info('Autonomous mode started via dashboard');
        await this.showDashboard(ctx);
        await ctx.answerCallbackQuery({ text: 'Started' });
        break;
      }

      case 'stop': {
        this.deps.setMode('stopped');
        logger.info('Bot stopped via dashboard');
        await this.showDashboard(ctx);
        await ctx.answerCallbackQuery({ text: 'Stopped' });
        break;
      }

      case 'back': {
        await this.showDashboard(ctx);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'view': {
        // View a specific dry run signal
        const sigId = data.split(':')[2];
        await this.showDryRunDetail(ctx, sigId);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'gmgn': {
        // Open the token on GMGN (sent as a tappable link).
        const address = data.split(':')[2];
        await ctx.answerCallbackQuery({ text: 'Opening GMGN...' });
        await ctx.reply(`🔗 [Open in GMGN](https://gmgn.ai/sol/token/${address})`, {
          parse_mode: 'Markdown',
        }).catch(() => undefined);
        break;
      }

      default:
        await ctx.answerCallbackQuery();
    }
  }

  /** Format a token price as a readable decimal (e.g. 0.000027), not exponential. */
  private formatPrice(price: number): string {
    if (price <= 0) return '0';
    if (price >= 0.01) return price.toFixed(6);
    const abs = Math.abs(price);
    const decimals = Math.max(6, Math.ceil(-Math.log10(abs)) + 2);
    return price.toFixed(decimals);
  }

  /** Show dry run signals as inline keyboard list */
  private async showDryRunPositions(ctx: Context): Promise<void> {
    const all = this.deps.dryRunLogger.getAllSignals();
    const open = this.deps.dryRunLogger.getOpenSignals();
    const statusCounts: Record<string, number> = {};
    for (const s of all) { const st = s.status || 'unknown'; statusCounts[st] = (statusCounts[st] || 0) + 1; }
    console.log(`[Dashboard] showDryRunPositions: total=${all.length}, open=${open.length}`, statusCounts);
    if (open.length === 0) {
      const kb = new InlineKeyboard().text('« Back', 'dash:back');
      await ctx.editMessageText(`📭 No open dry run signals. (total: ${all.length}, open: ${open.length})`, {
        reply_markup: kb,
      }).catch((e) => console.error('[Dashboard] editMessageText error:', e?.message || e));
      return;
    }

    const kb = new InlineKeyboard();
    for (const sig of open) {
      const pnl = sig.virtualPnlPct ?? 0;
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      const sign = pnl >= 0 ? '+' : '';
      kb.text(`${emoji} ${sig.symbol} ${sign}${pnl.toFixed(1)}%`, `dash:view:${sig.id}`);
      kb.row();
    }
    kb.text('« Back', 'dash:back');

    const text = `*📊 Dry Run Positions (${open.length})*\n\nTap a signal to view details:`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);
  }

  /** Show detail for a single dry run signal */
  private async showDryRunDetail(ctx: Context, sigId: string): Promise<void> {
    const signals = this.deps.dryRunLogger.getAllSignals();
    const sig = signals.find(s => s.id === sigId);
    if (!sig) {
      await ctx.answerCallbackQuery({ text: 'Signal not found' });
      return;
    }

    const pnl = sig.virtualPnlPct ?? 0;
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    const sign = pnl >= 0 ? '+' : '';
    const age = sig.entryTime ? Math.floor((Date.now() - sig.entryTime) / 60000) : 0;
    const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h${age % 60}m`;
    const mcapStr = sig.marketCap ? `${(sig.marketCap / 1000).toFixed(0)}K` : '—';
    const mcapSolStr = sig.marketCap && configManager.solPriceUsd > 0
      ? `◎${(sig.marketCap / configManager.solPriceUsd).toFixed(0)}`
      : '—';
    const volStr = sig.volume24h ? `${(sig.volume24h / 1000).toFixed(0)}K` : '—';
    const high = sig.highestPrice ? ((sig.highestPrice - sig.entryPrice) / sig.entryPrice * 100) : 0;
    const low = sig.lowestPrice ? ((sig.lowestPrice - sig.entryPrice) / sig.entryPrice * 100) : 0;
    const entryStr = this.formatPrice(sig.entryPrice);
    const entryUsd = sig.entryPrice > 0 && configManager.solPriceUsd > 0
      ? `$${this.formatPrice(sig.entryPrice * configManager.solPriceUsd)}`
      : '';
    const currentStr = sig.currentPrice ? this.formatPrice(sig.currentPrice) : '—';
    const currentUsd = sig.currentPrice && sig.currentPrice > 0 && configManager.solPriceUsd > 0
      ? `$${this.formatPrice(sig.currentPrice * configManager.solPriceUsd)}`
      : '';
    // MC at entry and now in SOL
    const entryMcSol = sig.entryPrice > 0 && configManager.solPriceUsd > 0 && sig.marketCap > 0
      ? `◎${((sig.entryPrice / (sig.currentPrice ?? sig.entryPrice)) * sig.marketCap / configManager.solPriceUsd).toFixed(0)}`
      : '';
    const nowMcSol = sig.marketCap && configManager.solPriceUsd > 0
      ? `◎${(sig.marketCap / configManager.solPriceUsd).toFixed(0)}`
      : '';

    let text = `*${sig.symbol}*\n`;
    text += `\`${sig.address}\`\n\n`;
    text += `💰 Entry: ◎${entryStr}${entryUsd ? ` (${entryUsd})` : ''} | MC ${entryMcSol}\n`;
    text += `📈 Now: ◎${currentStr}${currentUsd ? ` (${currentUsd})` : ''} | MC ${nowMcSol} (${sign}${pnl.toFixed(1)}%)\n`;
    text += `${emoji} PnL: ${sign}${pnl.toFixed(1)}%\n`;
    text += `📊 MC: ${mcapStr} / ${mcapSolStr} | Vol: ${volStr}\n`;
    text += `👥 Holders: ${sig.holders} | Score: ${sig.score}\n`;
    text += `⏳ Age: ${ageStr} | B/S: ${sig.buysSells}\n`;
    text += `📍 Peak: +${high.toFixed(0)}% | Low: ${low.toFixed(0)}%\n`;

    const kb = new InlineKeyboard()
      .text('🔄 Refresh', `dash:view:${sig.id}`)
      .text('📊 GMGN', `dash:gmgn:${sig.address}`)
      .row()
      .text('« Back', 'dash:positions');

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);
  }

  /** Show real positions (non-dry-run) */
  private async showRealPositions(ctx: Context): Promise<void> {
    await this.deps.positionManager.updatePricesNow().catch(() => undefined);
    const open = this.deps.positionManager.getOpenPositions();
    if (open.length === 0) {
      const kb = new InlineKeyboard().text('« Back', 'dash:back');
      await ctx.editMessageText('📭 No open positions.', {
        reply_markup: kb,
      }).catch(() => undefined);
      return;
    }

    const kb = new InlineKeyboard();
    for (const pos of open) {
      const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const sign = pnlPct >= 0 ? '+' : '';
      const emoji = pnlPct >= 0 ? '🟢' : '🔴';
      kb.text(`${emoji} ${pos.tokenSymbol} ${sign}${pnlPct.toFixed(1)}%`, `pos:view:${pos.tokenAddress}`);
      kb.row();
    }
    kb.text('🔄 Refresh', 'dash:positions').row();
    kb.text('« Back', 'dash:back');

    const text = `*📊 Open Positions (${open.length})*\n\nTap a position to view details:`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);
  }
}
