import { Bot, Context, InlineKeyboard } from 'grammy';
import { PositionManager } from '../../position/PositionManager.js';
import { ExecutionEngine } from '../../execution/ExecutionEngine.js';
import { Position } from '../../types/index.js';
import { STRATEGY } from '../../config/config.js';
import { configManager } from '../../config/ConfigManager.js';
import { escapeMarkdown } from '../../utils/markdown.js';
import { logger } from '../../logger/Logger.js';

interface PositionViewState {
  messageId?: number;
  chatId?: number;
}

/**
 * Position view with inline keyboard buttons.
 * Shows open positions with real-time PnL, partial sell buttons, and GMGN links.
 */
export class PositionView {
  private viewState: PositionViewState = {};

  constructor(
    private positions: PositionManager,
    private engine: ExecutionEngine,
  ) {}

  /** Register the /positions command and callback handlers */
  register(bot: Bot<Context>): void {
    // /positions command - show position list with refresh button
    bot.command('positions', async (ctx) => {
      const open = this.positions.getOpenPositions();
      if (open.length === 0) {
        await ctx.reply('📭 No open positions.');
        return;
      }

      // Show list view first (has Refresh button)
      await this.showPositionsListFromCommand(ctx);
    });

    // Callback handlers for position actions
    bot.callbackQuery(/^pos:/, async (ctx) => {
      try {
        await this.handleCallback(ctx);
      } catch (err) {
        logger.warn('Position callback failed', { data: ctx.callbackQuery.data, err: String(err) });
        await ctx.answerCallbackQuery({ text: 'Error' }).catch(() => undefined);
      }
    });
  }

  /** Show a single position with full details and buttons */
  async showPosition(ctx: Context, tokenAddress: string): Promise<void> {
    const pos = this.positions.getPosition(tokenAddress);
    if (!pos || pos.status !== 'open') {
      await ctx.reply('Position not found or already closed.');
      return;
    }

    const text = this.formatPositionCard(pos);
    const keyboard = this.buildKeyboard(pos);

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch {
      // Fallback to new message if edit fails (expired message, etc.)
      const sent = await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }).catch(() => null);
      if (sent) {
        this.viewState.messageId = sent.message_id;
        this.viewState.chatId = sent.chat.id;
      }
    }
  }

  /** Format a position card with all details */
  private formatPositionCard(pos: Position): string {
    const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlSign = pnlPct >= 0 ? '+' : '';
    const pnlEmoji = pnlPct >= 0 ? '🟢' : '🔴';
    const ageMs = Date.now() - pos.openedAt;
    const ageStr = ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m` : `${Math.floor(ageMs / 3600000)}h`;

    // Calculate remaining value. `tokensReceived` is RAW base units; currentPrice
    // is SOL per WHOLE token — so scale by decimals before multiplying, or the
    // value reads as millions of SOL.
    const dec = pos.decimals ?? 0;
    const remainingTokensUi = pos.tokensReceived / 10 ** dec;
    const remainingSol = remainingTokensUi * pos.currentPrice;

    // Read strategy params live so the card reflects the current /config values.
    const cfg = configManager.get();
    const firstTargetSellPct = cfg.strategy.firstTargetSellPct ?? STRATEGY.firstTargetSellPct;
    const takeProfitPct = cfg.strategy.takeProfitPct ?? STRATEGY.takeProfitPct;
    const trailingStopPct = cfg.strategy.trailingStopPct ?? STRATEGY.trailingStopPct;

    // Peak price tracked on the position itself (highest since entry).
    const peakPrice = pos.peakPrice;
    const peakStr = peakPrice < 0.01 ? peakPrice.toExponential(2) : peakPrice.toFixed(6);
    const peakPct = ((peakPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Entry/Current format with inline MC (SOL-denominated)
    const entryStr = pos.entryPrice < 0.01 ? pos.entryPrice.toExponential(2) : pos.entryPrice.toFixed(6);
    const currentStr = pos.currentPrice < 0.01 ? pos.currentPrice.toExponential(2) : pos.currentPrice.toFixed(6);
    const solUsd = configManager.solPriceUsd;

    // MC in SOL for entry and current
    const priceRatio = pos.entryPrice > 0 ? pos.currentPrice / pos.entryPrice : 1;
    let entryMcStr = '';
    let currentMcStr = '';
    if (pos.marketCapUsd && pos.marketCapUsd > 0 && solUsd > 0) {
      const entryMcSol = Math.round(pos.marketCapUsd / solUsd);
      const currentMcSol = Math.round((pos.marketCapUsd * priceRatio) / solUsd);
      entryMcStr = ` (MC: ◎${entryMcSol})`;
      currentMcStr = ` (MC: ◎${currentMcSol})`;
    }

    let text = '';
    text += `*${escapeMarkdown(pos.tokenSymbol)}*\n`;
    text += `\`${pos.tokenAddress}\`\n\n`;

    // Main metrics — MC inline with Entry/Current
    text += `*Entry:* \`${'◎'}${entryStr}${entryMcStr}\`\n`;
    text += `*Current:* \`${'◎'}${currentStr}${currentMcStr}\`\n`;
    text += `${pnlEmoji} *PnL:* \`${pnlSign}${pnlPct.toFixed(1)}%\`\n`;
    text += `\n`;

    // Position details
    text += `📊 *Position*\n`;
    text += `• Size: \`${pos.entryAmountSol.toFixed(3)} SOL\`\n`;
    text += `• Remaining: \`${Math.floor(remainingTokensUi).toLocaleString()} tokens\`\n`;
    text += `• Value: \`${remainingSol.toFixed(3)} SOL\`\n`;
    text += `• Age: \`${ageStr}\`\n\n`;

    // Risk management
    text += `⚙️ *Risk Management*\n`;
    text += `• SL: \`${pos.stopLossPct}%\`\n`;
    text += `• Peak: \`${peakStr}\` (\`${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(1)}%\`)\n`;

    // Exit strategy: show trailing TP status
    text += `\n📈 *Exit Strategy*\n`;
    if (pos.firstTargetHit) {
      text += `✅ TP hit (sold ${firstTargetSellPct}%)\n`;
      text += `🏃 Runner: trailing \`${trailingStopPct}%\` from peak\n`;
    } else {
      text += `🎯 TP: \`+${takeProfitPct}%\` (sell ${firstTargetSellPct}%)\n`;
      text += `🏃 Trail: \`${trailingStopPct}%\` drop from peak\n`;
    }

    // Status indicator
    const statusLabel = pos.status === 'stuck' ? '🔴 STUCK' : pos.status === 'open' ? '🟢 OPEN' : '⏳ PENDING';
    text += `\n*Status:* ${statusLabel}`;
    if (pos.status === 'stuck' && pos.sellRetryCount) {
      text += `\n⚠️ Sell failed after ${pos.sellRetryCount} retries — manual close needed`;
    }

    return text;
  }

  /** Build inline keyboard with action buttons */
  private buildKeyboard(pos: Position): InlineKeyboard {
    const kb = new InlineKeyboard();

    // Partial sell buttons
    kb.text('25%', `pos:sell:${pos.tokenAddress}:25`)
      .text('50%', `pos:sell:${pos.tokenAddress}:50`)
      .text('100%', `pos:sell:${pos.tokenAddress}:100`)
      .row();

    // Utility buttons
    kb.text('🔄 Refresh', `pos:refresh:${pos.tokenAddress}`)
      .text('📊 GMGN', `pos:gmgn:${pos.tokenAddress}`)
      .row();

    // Back to list
    kb.text('« Back to Positions', `pos:list`);

    return kb;
  }

  /** Handle callback queries */
  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const parts = data.split(':');
    const action = parts[1];

    switch (action) {
      case 'sell': {
        const tokenAddress = parts[2];
        const pct = parseInt(parts[3], 10);
        await this.handlePartialSell(ctx, tokenAddress, pct);
        break;
      }

      case 'refresh': {
        const tokenAddress = parts[2];
        await this.showPosition(ctx, tokenAddress);
        await ctx.answerCallbackQuery({ text: 'Refreshed' });
        break;
      }

      case 'gmgn': {
        const tokenAddress = parts[2];
        const url = `https://gmgn.ai/sol/token/${tokenAddress}`;
        await ctx.answerCallbackQuery({ text: 'Opening GMGN...', show_alert: false });
        // Send as a separate message with link
        await ctx.reply(`🔗 [Open in GMGN](${url})`, { parse_mode: 'Markdown' });
        break;
      }

      case 'list': {
        await this.showPositionsList(ctx);
        await ctx.answerCallbackQuery();
        break;
      }

      case 'confirmsell': {
        const tokenAddress = parts[2];
        const pct = parseInt(parts[3], 10);
        await this.executePartialSell(ctx, tokenAddress, pct);
        break;
      }

      case 'cancel': {
        const tokenAddress = parts[2];
        await this.showPosition(ctx, tokenAddress);
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        break;
      }

      case 'closeall': {
        await this.handleCloseAll(ctx);
        break;
      }

      case 'confirmcloseall': {
        await this.executeCloseAll(ctx);
        break;
      }

      case 'view': {
        const tokenAddress = parts[2];
        await this.showPosition(ctx, tokenAddress);
        await ctx.answerCallbackQuery();
        break;
      }

      default:
        await ctx.answerCallbackQuery();
    }
  }

  /** Handle partial sell */
  private async handlePartialSell(ctx: Context, tokenAddress: string, pct: number): Promise<void> {
    const pos = this.positions.getPosition(tokenAddress);
    if (!pos || pos.status !== 'open') {
      await ctx.answerCallbackQuery({ text: 'Position not found' });
      return;
    }

    // Calculate tokens to sell
    const tokensToSell = Math.floor(pos.tokensReceived * (pct / 100));
    if (tokensToSell <= 0) {
      await ctx.answerCallbackQuery({ text: 'No tokens to sell' });
      return;
    }

    // Confirm before selling. tokensToSell is RAW base units; scale by decimals
    // to value it (currentPrice is SOL per whole token) and to display a count.
    const dec = pos.decimals ?? 0;
    const tokensToSellUi = tokensToSell / 10 ** dec;
    const confirmText = `⚠️ Sell ${pct}% of ${escapeMarkdown(pos.tokenSymbol)}?\n\n` +
      `Tokens: \`${Math.floor(tokensToSellUi).toLocaleString()}\`\n` +
      `Estimated value: ~${(pos.currentPrice * tokensToSellUi).toFixed(3)} SOL\n\n` +
      `This action cannot be undone.`;

    const kb = new InlineKeyboard()
      .text('✅ Confirm Sell', `pos:confirmsell:${tokenAddress}:${pct}`)
      .text('❌ Cancel', `pos:cancel:${tokenAddress}`)
      .row();

    await ctx.editMessageText(confirmText, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);

    await ctx.answerCallbackQuery();
  }

  /** Execute the partial sell after confirmation */
  async executePartialSell(ctx: Context, tokenAddress: string, pct: number): Promise<void> {
    const pos = this.positions.getPosition(tokenAddress);
    if (!pos || pos.status !== 'open') {
      await ctx.answerCallbackQuery({ text: 'Position not found' });
      return;
    }

    const tokensToSell = Math.floor(pos.tokensReceived * (pct / 100));

    await ctx.answerCallbackQuery({ text: `Selling ${pct}%...` });

    // Execute sell
    const result = await this.engine.sell(tokenAddress, tokensToSell);
    if (!result.success) {
      await ctx.reply(`❌ Sell failed: ${result.error}`);
      // Refresh the view
      await this.showPosition(ctx, tokenAddress);
      return;
    }

    // Update position - reduce remaining tokens
    pos.tokensReceived -= tokensToSell;

    const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const solReceived = Math.abs(result.solSpent ?? 0);

    // Notify success. Token counts are RAW base units — scale to whole tokens.
    const dec = pos.decimals ?? 0;
    const msg = `✅ *Sold ${pct}% of ${escapeMarkdown(pos.tokenSymbol)}*\n\n` +
      `• Tokens sold: \`${Math.floor(tokensToSell / 10 ** dec).toLocaleString()}\`\n` +
      `• SOL received: \`${solReceived.toFixed(4)} SOL\`\n` +
      `• Remaining: \`${Math.floor(pos.tokensReceived / 10 ** dec).toLocaleString()} tokens\`\n` +
      `• Current PnL: \`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%\`\n\n` +
      `Tx: \`${result.txSig}\``;

    await ctx.reply(msg, { parse_mode: 'Markdown' });

    // If all tokens sold, close position
    if (pos.tokensReceived <= 0) {
      pos.status = 'closed';
      pos.closedAt = Date.now();
      pos.exitTxSig = result.txSig;
      pos.exitAmountSol = solReceived;
      pos.realisedPnlSol = solReceived - pos.entryAmountSol;
      pos.closeReason = 'manual';
      this.positions.getPosition(tokenAddress); // Trigger cleanup
      await ctx.reply(`🏁 Position ${pos.tokenSymbol} fully closed.`);
    } else {
      // Refresh the position view
      await this.showPosition(ctx, tokenAddress);
    }
  }

  /** Confirm dialog for closing all positions */
  private async handleCloseAll(ctx: Context): Promise<void> {
    const open = this.positions.getOpenPositions();
    if (open.length === 0) {
      await ctx.answerCallbackQuery({ text: 'No open positions' });
      return;
    }

    let totalValue = 0;
    let totalPnl = 0;
    for (const pos of open) {
      // tokensReceived is RAW base units; prices are SOL per WHOLE token — scale
      // by decimals before multiplying, or values read as millions of SOL.
      const dec = pos.decimals ?? 0;
      const tokensUi = pos.tokensReceived / 10 ** dec;
      totalValue += tokensUi * pos.currentPrice;
      totalPnl += (pos.currentPrice - pos.entryPrice) * tokensUi;
    }

    const confirmText = `⚠️ *Close ALL ${open.length} positions?*\n\n` +
      `Total value: ~${totalValue.toFixed(3)} SOL\n` +
      `Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL\n\n` +
      `This will sell 100% of each position. Cannot be undone.`;

    const kb = new InlineKeyboard()
      .text('✅ Confirm Close All', 'pos:confirmcloseall')
      .text('❌ Cancel', 'pos:list')
      .row();

    await ctx.editMessageText(confirmText, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);

    await ctx.answerCallbackQuery();
  }

  /** Execute close all positions */
  private async executeCloseAll(ctx: Context): Promise<void> {
    const open = this.positions.getOpenPositions();
    if (open.length === 0) {
      await ctx.answerCallbackQuery({ text: 'No open positions' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Closing ${open.length} positions...` });
    await ctx.editMessageText(`⏳ Closing ${open.length} positions...`).catch(() => undefined);

    const results: string[] = [];
    let closed = 0;
    let failed = 0;

    for (const pos of open) {
      try {
        const sym = escapeMarkdown(pos.tokenSymbol);
        const tokensToSell = pos.tokensReceived;
        if (tokensToSell <= 0) {
          results.push(`⚠️ ${sym}: no tokens remaining`);
          continue;
        }

        const result = await this.engine.sell(pos.tokenAddress, tokensToSell);
        if (result.success) {
          const solReceived = Math.abs(result.solSpent ?? 0);
          const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

          // Update position
          pos.tokensReceived = 0;
          pos.status = 'closed';
          pos.closedAt = Date.now();
          pos.exitTxSig = result.txSig;
          pos.exitAmountSol = solReceived;
          pos.realisedPnlSol = solReceived - pos.entryAmountSol;
          pos.closeReason = 'manual';

          results.push(`✅ ${sym}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${solReceived.toFixed(4)} SOL)`);
          closed++;
        } else {
          results.push(`❌ ${sym}: ${escapeMarkdown(String(result.error))}`);
          failed++;
        }
      } catch (err) {
        results.push(`❌ ${escapeMarkdown(pos.tokenSymbol)}: ${escapeMarkdown(String(err))}`);
        failed++;
      }
    }

    let msg = `🏁 *Close All Complete*\n\n`;
    msg += `Closed: ${closed}/${open.length}\n`;
    if (failed > 0) msg += `Failed: ${failed}\n`;
    msg += `\n${results.join('\n')}`;

    await ctx.editMessageText(msg, { parse_mode: 'Markdown' }).catch(() => undefined);
  }

  /** Show positions list as a NEW message (from /positions command) */
  private async showPositionsListFromCommand(ctx: Context): Promise<void> {
    await this.positions.updatePricesNow().catch(() => undefined);
    const open = this.positions.getOpenPositions();
    if (open.length === 0) {
      await ctx.reply('📭 No open positions.');
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

    if (open.length > 1) {
      kb.text('⚠️ Close All', `pos:closeall`).row();
    }

    kb.text('🔄 Refresh', `pos:list`).row();
    kb.text('⬅️ Dashboard', `dash:back`).row();

    const text = `*Open Positions (${open.length})*\n\nTap a position to view details:`;

    const sent = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => null);

    if (sent) {
      this.viewState.messageId = sent.message_id;
      this.viewState.chatId = sent.chat.id;
    }
  }

  /** Show positions list by EDITING existing message (from callback) */
  private async showPositionsList(ctx: Context): Promise<void> {
    // Trigger an immediate price refresh so PnL% is fresh when the user opens
    // the list. Fire-and-forget — if it fails the stale prices are still shown.
    await this.positions.updatePricesNow().catch(() => undefined);
    const open = this.positions.getOpenPositions();
    if (open.length === 0) {
      await ctx.editMessageText('📭 No open positions.').catch(() => undefined);
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

    // Close All button (only if more than 1 position)
    if (open.length > 1) {
      kb.text('⚠️ Close All', `pos:closeall`).row();
    }

    // Navigation: Refresh + Back to Dashboard
    kb.text('🔄 Refresh', `pos:list`).row();
    kb.text('⬅️ Dashboard', `dash:back`).row();

    const text = `*Open Positions (${open.length})*\n\nTap a position to view details:`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => undefined);
  }
}
