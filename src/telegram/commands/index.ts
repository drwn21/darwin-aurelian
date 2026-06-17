import { Bot, Context } from 'grammy';
import { PositionManager } from '../../position/PositionManager.js';
import { RiskManager } from '../../risk/RiskManager.js';
import { TradeHistory } from '../../logger/TradeHistory.js';
import { ExecutionEngine } from '../../execution/ExecutionEngine.js';
import { GmgnClient } from '../../discovery/GmgnClient.js';
import { TokenFilter } from '../../screening/TokenFilter.js';
import { RugChecker } from '../../screening/RugChecker.js';
import { getWalletBalanceSol } from '../../utils/solana.js';
import { DryRunLogger } from '../../dryrun/DryRunLogger.js';
import { BotMode } from '../../types/index.js';

interface BotDeps {
  positionManager: PositionManager;
  riskManager: RiskManager;
  tradeHistory: TradeHistory;
  engine: ExecutionEngine;
  dryRunLogger: DryRunLogger;
  getMode: () => BotMode;
  setMode: (m: BotMode) => void;
}

export function registerCommands(bot: Bot<Context>, deps: BotDeps): void {
  const { positionManager, riskManager, tradeHistory, engine, dryRunLogger, getMode } = deps;

  // /start and /stop are handled by DashboardView.
  // /config and cfg:* callbacks are handled by the shared ConfigPanel (see TelegramBot).
  // /positions is handled by PositionView (real) and DashboardView (dry run).

  bot.command('mode', (ctx) => {
    ctx.reply(`Current mode: *${getMode()}*`, { parse_mode: 'Markdown' });
  });

  bot.command('status', async (ctx) => {
    const [balance, riskStatus, positions] = await Promise.all([
      getWalletBalanceSol(),
      riskManager.formatStatus(),
      positionManager.formatPositionsSummary(),
    ]);
    ctx.reply(
      `*Status*\nMode: ${getMode()}\nBalance: ${balance.toFixed(4)} SOL\n\n` +
        `*Risk*\n${riskStatus}\n\n` +
        `*Positions*\n${positions}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('pnl', (ctx) => {
    ctx.reply(`*PnL Summary*\n${tradeHistory.getSummary()}`, { parse_mode: 'Markdown' });
  });

  bot.command('balance', async (ctx) => {
    const bal = await getWalletBalanceSol();
    ctx.reply(`Wallet balance: *${bal.toFixed(4)} SOL*`, { parse_mode: 'Markdown' });
  });

  // /buy <tokenAddress> [amountSOL]
  bot.command('buy', async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    const tokenAddress = args[0];
    if (!tokenAddress) {
      await ctx.reply('Usage: /buy <tokenAddress> [amountSOL]');
      return;
    }

    const client = new GmgnClient();
    const filter = new TokenFilter();
    const rugChecker = new RugChecker();

    const token = await client.fetchTokenInfo(tokenAddress);
    if (!token) {
      await ctx.reply(`Could not fetch token info for ${tokenAddress}`);
      return;
    }

    const rugResult = rugChecker.check(token);
    if (rugResult.isRug) {
      await ctx.reply(`Rug check FAILED for ${token.symbol}: ${rugResult.flags.join(', ')}`);
      return;
    }

    const filterResult = filter.filter(token);
    if (!filterResult.passed) {
      await ctx.reply(
        `Token ${token.symbol} failed screening:\n${filterResult.reasons.join('\n')}\n\nContinue anyway? Reply /buy_force ${tokenAddress}`,
      );
      return;
    }

    const amountSol = args[1] ? parseFloat(args[1]) : riskManager.getPositionSizeSol();
    await ctx.reply(`Buying ${token.symbol} with ${amountSol} SOL...`);

    const result = await engine.buy(tokenAddress, amountSol);
    if (!result.success) {
      await ctx.reply(`Buy failed: ${result.error}`);
      return;
    }

    await positionManager.openPosition(
      tokenAddress,
      token.symbol,
      token.price,
      amountSol,
      result.tokensReceived ?? 0,
      result.txSig ?? '',
      token.decimals,
      token.marketCap,
    );
    await ctx.reply(
      `Bought ${token.symbol}\nSOL spent: ${amountSol}\nTx: ${result.txSig}`,
    );
  });

  // /buy_force <tokenAddress> — skip filter, manual override
  bot.command('buy_force', async (ctx) => {
    const tokenAddress = ctx.match.trim();
    if (!tokenAddress) {
      await ctx.reply('Usage: /buy_force <tokenAddress>');
      return;
    }

    const client = new GmgnClient();
    const token = await client.fetchTokenInfo(tokenAddress);
    if (!token) {
      await ctx.reply(`Could not fetch token: ${tokenAddress}`);
      return;
    }

    const amountSol = riskManager.getPositionSizeSol();
    await ctx.reply(`Force-buying ${token.symbol} with ${amountSol} SOL (filters bypassed)...`);

    const result = await engine.buy(tokenAddress, amountSol);
    if (!result.success) {
      await ctx.reply(`Buy failed: ${result.error}`);
      return;
    }

    await positionManager.openPosition(
      tokenAddress,
      token.symbol,
      token.price,
      amountSol,
      result.tokensReceived ?? 0,
      result.txSig ?? '',
      token.decimals,
      token.marketCap,
    );
    await ctx.reply(`Bought ${token.symbol}. Tx: ${result.txSig}`);
  });

  // /sell <tokenAddress> — sell full position
  bot.command('sell', async (ctx) => {
    const tokenAddress = ctx.match.trim();
    if (!tokenAddress) {
      await ctx.reply('Usage: /sell <tokenAddress>');
      return;
    }

    if (!positionManager.hasPosition(tokenAddress)) {
      await ctx.reply('No open position for that token. Use /sell_raw to sell without a tracked position.');
      return;
    }

    await ctx.reply('Selling position...');
    await positionManager.closePosition(tokenAddress, 'manual');
    await ctx.reply('Position closed.');
  });

  // /sell_raw <tokenAddress> — sell without a tracked position (emergency)
  bot.command('sell_raw', async (ctx) => {
    const tokenAddress = ctx.match.trim();
    if (!tokenAddress) {
      await ctx.reply('Usage: /sell_raw <tokenAddress>');
      return;
    }

    await ctx.reply(`Selling all ${tokenAddress}...`);
    const result = await engine.sell(tokenAddress);
    if (!result.success) {
      await ctx.reply(`Sell failed: ${result.error}`);
      return;
    }
    await ctx.reply(`Sold. Tx: ${result.txSig}`);
  });

  bot.command('dryrun', async (ctx) => {
    const signals = dryRunLogger.getAllSignals();
    if (signals.length === 0) {
      await ctx.reply('No dry run signals yet. Start bot with /start and wait for signals.');
      return;
    }
    await ctx.reply(dryRunLogger.formatSummary(), { parse_mode: 'Markdown' });
  });

  bot.command('help', (ctx) => {
    ctx.reply(
      `*Available Commands*\n\n` +
        `/start — start autonomous sniping\n` +
        `/stop — pause autonomous mode\n` +
        `/status — full status overview\n` +
        `/positions — list open positions\n` +
        `/pnl — PnL summary\n` +
        `/balance — wallet SOL balance\n` +
        `/buy <addr> [sol] — manual buy\n` +
        `/buy_force <addr> — buy skipping filters\n` +
        `/sell <addr> — close tracked position\n` +
        `/sell_raw <addr> — sell any token balance\n` +
        `/config — open settings panel\n` +
        `/mode — show current mode\n` +
        `/help — this message`,
      { parse_mode: 'Markdown' },
    );
  });
}
