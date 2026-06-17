import { Bot, Context } from 'grammy';
import { ENV } from '../config/config.js';
import { PositionManager } from '../position/PositionManager.js';
import { RiskManager } from '../risk/RiskManager.js';
import { TradeHistory } from '../logger/TradeHistory.js';
import { ExecutionEngine } from '../execution/ExecutionEngine.js';
import { DryRunLogger } from '../dryrun/DryRunLogger.js';
import { BotMode, Position } from '../types/index.js';
import { PositionView } from './views/PositionView.js';
import { DashboardView } from './views/DashboardView.js';
import { consumePendingInput } from './inputWaiter.js';
import { ConfigPanel } from './config/ConfigPanel.js';
import { registerCommands } from './commands/index.js';
import { escapeMarkdown } from '../utils/markdown.js';
import { logger } from '../logger/Logger.js';

export class TelegramBot {
  private bot: Bot<Context>;
  private mode: BotMode = 'stopped';

  constructor(
    private positionManager: PositionManager,
    private riskManager: RiskManager,
    private tradeHistory: TradeHistory,
    private engine: ExecutionEngine,
    private dryRunLogger: DryRunLogger,
  ) {
    this.bot = new Bot<Context>(ENV.telegramBotToken);
    this.setupHandlers();
  }

  getMode(): BotMode {
    return this.mode;
  }

  setMode(mode: BotMode): void {
    this.mode = mode;
  }

  async notify(message: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(ENV.telegramChatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.warn('Telegram notify failed', { err: String(err) });
    }
  }

  async notifyPositionClosed(pos: Position): Promise<void> {
    const pnl = pos.realisedPnlSol ?? 0;
    const pnlPct = pos.entryAmountSol > 0 ? (pnl / pos.entryAmountSol) * 100 : 0;
    const emoji = pnl >= 0 ? '✅' : '❌';
    await this.notify(
      `${emoji} *Position Closed*\n` +
        `Token: ${escapeMarkdown(pos.tokenSymbol)}\n` +
        `Reason: ${escapeMarkdown(pos.closeReason ?? 'unknown')}\n` +
        `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`,
    );
  }

  async start(): Promise<void> {
    logger.info('Telegram bot starting...');
    this.bot.catch((err) => {
      logger.error('Telegram bot error', { err: String(err) });
    });
    // Non-blocking start
    void this.bot.start({
      onStart: () => {
        logger.info('Telegram bot connected');
        // Register command menu (dropdown when user types /)
        void this.bot.api.setMyCommands([
          { command: 'start', description: 'Start autonomous scanning' },
          { command: 'stop', description: 'Stop autonomous scanning' },
          { command: 'positions', description: 'View open positions' },
          { command: 'pnl', description: 'View PnL summary' },
          { command: 'dryrun', description: 'View dry run signals' },
          { command: 'config', description: 'Bot configuration' },
          { command: 'balance', description: 'Check wallet balance' },
          { command: 'status', description: 'Bot status info' },
          { command: 'help', description: 'Show all commands' },
        ]).catch((err) => logger.warn('setMyCommands failed', { err: String(err) }));
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info('Telegram bot stopped');
  }

  private setupHandlers(): void {
    // ── Auth gate ──────────────────────────────────────────────────────────
    // The bot controls a live wallet (buy/sell/config/start-stop). Without this
    // guard ANY Telegram user who finds the bot could drive it. Reject every
    // update that doesn't originate from the configured owner chat, silently.
    // Runs first so it covers messages AND inline-button callback queries.
    this.bot.use(async (ctx, next) => {
      const fromId = (ctx.chat?.id ?? ctx.from?.id)?.toString();
      if (fromId !== ENV.telegramChatId.toString()) {
        logger.warn('Rejected unauthorized Telegram update', { fromId: fromId ?? 'unknown' });
        return; // ignore — do not pass to any handler
      }
      return next();
    });

    // Shared config panel — registers /config + cfg:* callbacks
    const configPanel = new ConfigPanel(() => this.mode, (m) => { this.mode = m; });
    configPanel.register(this.bot);

    // Intercept text messages for pending config input — must be before command handlers
    this.bot.on('message:text', async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
      const fieldId = consumePendingInput(chatId);
      if (fieldId) {
        const text = ctx.message?.text?.trim() ?? '';
        await configPanel.handleTypedValue(ctx, fieldId, text);
        return; // consume — don't pass to command handlers
      }
      return next();
    });

    // Register dashboard (main hub with inline keyboard)
    const dashboard = new DashboardView({
      positionManager: this.positionManager,
      riskManager: this.riskManager,
      tradeHistory: this.tradeHistory,
      dryRunLogger: this.dryRunLogger,
      configPanel,
      getMode: () => this.mode,
      setMode: (m) => { this.mode = m; },
    });
    dashboard.register(this.bot);

    // Register position view with inline keyboard
    const positionView = new PositionView(this.positionManager, this.engine);
    positionView.register(this.bot);

    registerCommands(this.bot, {
      positionManager: this.positionManager,
      riskManager: this.riskManager,
      tradeHistory: this.tradeHistory,
      engine: this.engine,
      dryRunLogger: this.dryRunLogger,
      getMode: () => this.mode,
      setMode: (m) => { this.mode = m; },
    });
  }
}
