import { Bot, Context, InlineKeyboard } from 'grammy';
import { BotMode } from '../../types/index.js';
import { configManager } from '../../config/ConfigManager.js';
import { ENV } from '../../config/config.js';
import { logger } from '../../logger/Logger.js';
import { setPendingInput } from '../inputWaiter.js';
import {
  PANELS,
  PanelId,
  Field,
  NumberField,
  fieldById,
  fieldsForPanel,
  formatField,
  formatNumber,
  formatDelta,
  buttonDeltas,
  applyDelta,
} from './fields.js';

/** What a rendered view consists of. */
interface View {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Telegram inline-keyboard settings panel backed by {@link configManager}.
 *
 * Navigation lives entirely in callback_data with a compact `cfg:*` scheme:
 *   cfg:p:<panel>        switch to a panel (tab / sub-section)
 *   cfg:e:<fieldId>      open a field's edit view
 *   cfg:a:<fieldId>:<i>  apply increment/decrement delta #i
 *   cfg:o:<fieldId>:<i>  select enum option #i
 *   cfg:t:<mode|dry>     toggle the mode / dry-run switches
 *   cfg:back             return to the main panel
 *   cfg:close            dismiss the panel
 *
 * Every change is written through configManager (→ config/runtime.json) and is
 * read live by the rest of the bot, so edits take effect without a restart.
 */
export class ConfigPanel {
  constructor(
    private getMode: () => BotMode = () => 'stopped',
    private setMode: (mode: BotMode) => void = () => {},
  ) {}

  /** Register the /config command and the cfg:* callback handler. */
  register(bot: Bot<Context>): void {
    bot.command('config', async (ctx) => {
      if (!this.authorized(ctx)) return;
      const view = this.renderPanel('main');
      await ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
    });

    bot.callbackQuery(/^cfg:/, async (ctx) => {
      if (!this.authorized(ctx)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
        return;
      }
      try {
        await this.handleCallback(ctx);
      } catch (err) {
        logger.warn('Config callback failed', { data: ctx.callbackQuery.data, err: String(err) });
        await ctx.answerCallbackQuery({ text: 'Error applying change' }).catch(() => undefined);
      }
    });
  }

  /**
   * Open the main settings panel in place. Public entry point so other views
   * (e.g. the dashboard's ⚙️ Config button) can deep-link straight into it.
   */
  async open(ctx: Context): Promise<void> {
    if (!this.authorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true }).catch(() => undefined);
      return;
    }
    await this.show(ctx, this.renderPanel('main'));
    await ctx.answerCallbackQuery().catch(() => undefined);
  }

  /** Handle a text message that was consumed as a pending config input. */
  async handleTypedValue(ctx: Context, fieldId: string, text: string): Promise<void> {
    const field = fieldById(fieldId);
    if (!field || field.type !== 'number') return;

    const parsed = parseFloat(text);
    if (isNaN(parsed)) {
      await ctx.reply('❌ Invalid number. Change cancelled.');
      return;
    }
    const clamped = Math.min(field.max, Math.max(field.min, parsed));
    const stored = parseFloat((clamped * field.scale).toFixed(6));
    configManager.setByPath(field.path, stored);
    await this.show(ctx, this.renderEdit(field));
    await ctx.reply(`✅ ${field.label}: ${formatNumber(field, stored)}`);
  }

  // ── Callback routing ────────────────────────────────────────────────────

  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const [, action, arg, extra] = data.split(':');

    switch (action) {
      case 'open':
        await this.show(ctx, this.renderPanel('main'));
        await ctx.answerCallbackQuery();
        return;

      case 'p':
        await this.show(ctx, this.renderPanel(arg as PanelId));
        await ctx.answerCallbackQuery();
        return;

      case 'e': {
        const field = fieldById(arg);
        if (!field) return void (await ctx.answerCallbackQuery());
        // Boolean fields toggle in place — no separate edit view.
        if (field.type === 'boolean') {
          const next = !configManager.getByPath(field.path);
          configManager.setByPath(field.path, next);
          await this.show(ctx, this.renderPanel(field.panel));
          await ctx.answerCallbackQuery({ text: `${field.label}: ${next ? 'ON' : 'OFF'}` });
          return;
        }
        await this.show(ctx, this.renderEdit(field));
        await ctx.answerCallbackQuery();
        return;
      }

      case 'a': {
        const field = fieldById(arg);
        if (!field || field.type !== 'number') return void (await ctx.answerCallbackQuery());
        const deltas = buttonDeltas(field);
        const delta = deltas[Number(extra)];
        if (delta === undefined) return void (await ctx.answerCallbackQuery());
        const current = Number(configManager.getByPath(field.path));
        const next = applyDelta(field, current, delta);
        configManager.setByPath(field.path, next);
        await this.show(ctx, this.renderEdit(field));
        await ctx.answerCallbackQuery({ text: `${field.label}: ${formatNumber(field, next)}` });
        return;
      }

      case 'o': {
        const field = fieldById(arg);
        if (!field || field.type !== 'enum') return void (await ctx.answerCallbackQuery());
        const option = field.options[Number(extra)];
        if (option === undefined) return void (await ctx.answerCallbackQuery());
        configManager.setByPath(field.path, option);
        await this.show(ctx, this.renderPanel(field.panel));
        await ctx.answerCallbackQuery({ text: `${field.label}: ${option}` });
        return;
      }

      case 't': {
        const cfg = configManager.get();
        if (arg === 'mode') {
          const next = cfg.mode === 'production' ? 'test' : 'production';
          configManager.setByPath('mode', next);
          await this.show(ctx, this.renderPanel('main'));
          await ctx.answerCallbackQuery({ text: `Mode: ${next.toUpperCase()}` });
        } else if (arg === 'dry') {
          const next = !cfg.dryRun;
          configManager.setByPath('dryRun', next);
          await this.show(ctx, this.renderPanel('main'));
          await ctx.answerCallbackQuery({ text: `Dry-run: ${next ? 'ON' : 'OFF'}` });
        } else if (arg === 'stop') {
          const current = this.getMode();
          const next: BotMode = current === 'stopped' ? 'autonomous' : 'stopped';
          this.setMode(next);
          await this.show(ctx, this.renderPanel('main'));
          await ctx.answerCallbackQuery({ text: next === 'stopped' ? 'Bot STOPPED' : 'Bot STARTED' });
        } else {
          await ctx.answerCallbackQuery();
        }
        return;
      }

      case 'type': {
        // User wants to type a custom value for a number field
        const field = fieldById(arg);
        if (!field || field.type !== 'number') return void (await ctx.answerCallbackQuery());
        const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
        setPendingInput(chatId, field.id);
        await ctx.answerCallbackQuery({ text: 'Type the value now...' });
        await ctx.reply(`✏️ *${field.label}*\nType the new value (${formatNumber(field, field.min * field.scale)} – ${formatNumber(field, field.max * field.scale)}):`, { parse_mode: 'Markdown' });
        return;
      }

      case 'back':
        await this.show(ctx, this.renderPanel('main'));
        await ctx.answerCallbackQuery();
        return;

      case 'close':
        await ctx.deleteMessage().catch(() => undefined);
        await ctx.answerCallbackQuery({ text: 'Closed' });
        return;

      default:
        await ctx.answerCallbackQuery();
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Tab row (Main · Risk · Strategy) + sub-section row (Screening · GMGN). */
  private navRows(active: PanelId, kb: InlineKeyboard): void {
    const tab = (id: PanelId) => {
      const meta = PANELS.find((p) => p.id === id)!;
      return id === active ? `• ${meta.title}` : meta.title;
    };
    kb.text(tab('main'), 'cfg:p:main')
      .text(tab('risk'), 'cfg:p:risk')
      .text(tab('strategy'), 'cfg:p:strategy')
      .row();
    kb.text(tab('screen'), 'cfg:p:screen')
      .text(tab('gmgn'), 'cfg:p:gmgn')
      .text(tab('safety'), 'cfg:p:safety')
      .row();
  }

  private renderPanel(panelId: PanelId): View {
    const panel = PANELS.find((p) => p.id === panelId) ?? PANELS[0];
    const active = panel.id;
    const cfg = configManager.get();
    const kb = new InlineKeyboard();
    this.navRows(active, kb);

    for (const field of fieldsForPanel(active)) {
      const value = configManager.getByPath(field.path);
      kb.text(`${field.label}: ${formatField(field, value)}`, `cfg:e:${field.id}`).row();
    }

    // Mode / dry-run live on the Main panel as direct toggles.
    if (active === 'main') {
      const botRunning = this.getMode() !== 'stopped';
      kb.text(botRunning ? '⏹ Stop Bot' : '▶️ Start Bot', 'cfg:t:stop').row();
      kb.text(`Mode: ${cfg.mode === 'production' ? 'PRODUCTION 🔴' : 'TEST 🟢'}`, 'cfg:t:mode').row();
      kb.text(`Dry-run: ${cfg.dryRun ? 'ON 🟢' : 'OFF ⚪'}`, 'cfg:t:dry').row();
    }

    kb.text('✖ Close', 'cfg:close');

    const text =
      `⚙️ *Config — ${panel.title}*\n` +
      `Mode: \`${cfg.mode.toUpperCase()}\` · Dry-run: \`${cfg.dryRun ? 'ON' : 'OFF'}\`\n\n` +
      'Tap a setting to edit. Changes apply immediately.';
    return { text, keyboard: kb };
  }

  private renderEdit(field: Field): View {
    const value = configManager.getByPath(field.path);
    const kb = new InlineKeyboard();

    if (field.type === 'enum') {
      for (const [i, option] of field.options.entries()) {
        const mark = option === value ? '• ' : '';
        kb.text(`${mark}${option}`, `cfg:o:${field.id}:${i}`).row();
      }
      kb.text('« Back', `cfg:p:${field.panel}`);
      const text = `✏️ *${field.label}*\nCurrent: \`${value}\`\n\nChoose an option:`;
      return { text, keyboard: kb };
    }

    // Boolean fields toggle directly from the panel (no edit view); fall back to
    // the panel render defensively if one ever reaches here.
    if (field.type === 'boolean') {
      return this.renderPanel(field.panel);
    }

    return this.renderNumberEdit(field, Number(value), kb);
  }

  private renderNumberEdit(field: NumberField, value: number, kb: InlineKeyboard): View {
    const deltas = buttonDeltas(field);
    deltas.forEach((delta, i) => {
      kb.text(formatDelta(field, delta), `cfg:a:${field.id}:${i}`);
    });
    kb.row();
    kb.text('✏️ Type value', `cfg:type:${field.id}`).row();
    kb.text('« Back', `cfg:p:${field.panel}`);

    const text =
      `✏️ *${field.label}*\n` +
      `Current: \`${formatNumber(field, value)}\`\n` +
      `Range: ${formatNumber(field, field.min * field.scale)} – ${formatNumber(field, field.max * field.scale)}\n\n` +
      'Use the buttons to adjust:';
    return { text, keyboard: kb };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Replace the panel message in place; falls back to a fresh reply. */
  private async show(ctx: Context, view: View): Promise<void> {
    try {
      await ctx.editMessageText(view.text, {
        parse_mode: 'Markdown',
        reply_markup: view.keyboard,
      });
    } catch {
      // "message is not modified" or an expired message — send a new one.
      await ctx
        .reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard })
        .catch(() => undefined);
    }
  }

  /** Restrict the panel to the configured operator chat. */
  private authorized(ctx: Context): boolean {
    return String(ctx.chat?.id ?? ctx.from?.id ?? '') === ENV.telegramChatId;
  }
}
