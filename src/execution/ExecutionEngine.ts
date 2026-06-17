import { LAMPORTS_PER_SOL, WSOL_MINT } from '../config/constants.js';
import { configManager } from '../config/ConfigManager.js';
import { SwapResult } from '../types/index.js';
import { JupiterClient } from './JupiterClient.js';
import { getWallet, getTokenBalance, deserializeVersionedTransaction, sendAndConfirmVersionedTx } from '../utils/solana.js';
import { isKnownBundlerToken, checkBundlerPattern } from '../screening/BundlerDetector.js';
import { logger } from '../logger/Logger.js';
import { tradeLog } from '../logger/Logger.js';

export class ExecutionEngine {
  private jupiter: JupiterClient;

  constructor(jupiter?: JupiterClient) {
    this.jupiter = jupiter ?? new JupiterClient();
  }

  /**
   * Buy `amountSol` worth of `tokenMint` using Jupiter.
   * Returns tokens received and tx signature.
   */
  async buy(tokenMint: string, amountSol: number): Promise<SwapResult> {
    const wallet = getWallet();
    const { buySlippageBps, priorityFeeLamports } = configManager.get().strategy;
    const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // Pre-buy bundler gate: refuse to enter a token that history already flagged
    // as a bundler, or that shows an active transfer-burst right now. Gated by
    // the same safety toggle as the runtime monitor, and no-ops without a
    // Helius key (checkBundlerPattern returns a neutral result).
    if (configManager.get().safety?.bundlerCheckEnabled !== false) {
      if (isKnownBundlerToken(tokenMint)) {
        logger.warn('Buy skipped — known bundler token', { token: tokenMint });
        return { success: false, error: 'Bundler token (known)' };
      }
      const bundler = await checkBundlerPattern(tokenMint);
      if (bundler.isBundler) {
        logger.warn('Buy skipped — active bundler pattern', { token: tokenMint, details: bundler.details });
        return { success: false, error: 'Bundler pattern detected' };
      }
    }

    logger.info('Executing buy', { token: tokenMint, sol: amountSol });

    // Retry up to 3 times with backoff when getQuote returns null (404 / no route)
    const MAX_BUY_RETRIES = 3;
    const BUY_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
    let quote = await this.jupiter.getQuote(
      WSOL_MINT,
      tokenMint,
      amountLamports,
      buySlippageBps,
    );
    for (let attempt = 0; !quote && attempt < MAX_BUY_RETRIES; attempt++) {
      logger.warn('Buy quote returned null, retrying', {
        token: tokenMint,
        attempt: attempt + 1,
        maxRetries: MAX_BUY_RETRIES,
        delayMs: BUY_RETRY_DELAYS_MS[attempt],
      });
      await new Promise((r) => setTimeout(r, BUY_RETRY_DELAYS_MS[attempt]));
      quote = await this.jupiter.getQuote(
        WSOL_MINT,
        tokenMint,
        amountLamports,
        buySlippageBps,
      );
    }
    if (!quote) {
      logger.error('Buy quote failed after all retries', { token: tokenMint });
      return { success: false, error: 'Failed to get Jupiter quote (all retries exhausted)' };
    }

    const txBuf = await this.jupiter.buildSwapTransaction(
      quote,
      wallet.publicKey.toBase58(),
      priorityFeeLamports,
    );
    if (!txBuf) return { success: false, error: 'Failed to build swap transaction' };

    try {
      const tx = deserializeVersionedTransaction(txBuf);
      const txSig = await sendAndConfirmVersionedTx(tx);
      // Use actual on-chain balance — slippage can cause the real amount to
      // differ from the quoted outAmount.
      let tokensReceived = await getTokenBalance(tokenMint);
      if (tokensReceived <= 0) {
        logger.warn('getTokenBalance returned 0 after buy — falling back to quote', { token: tokenMint });
        tokensReceived = Number(quote.outAmount);
      }

      tradeLog('BUY_EXECUTED', {
        token: tokenMint,
        solSpent: amountSol,
        tokensReceived,
        txSig,
        slippageBps: configManager.get().strategy.buySlippageBps,
      });

      return { success: true, txSig, tokensReceived, solSpent: amountSol };
    } catch (err) {
      logger.error('Buy transaction failed', { token: tokenMint, err: String(err) });
      return { success: false, error: String(err) };
    }
  }

  /**
   * Sell `tokenAmountRaw` (in raw token units) back to SOL.
   * Pass 0 to auto-fetch and sell full balance.
   */
  async sell(tokenMint: string, tokenAmountRaw?: number): Promise<SwapResult> {
    const wallet = getWallet();

    const amount = tokenAmountRaw ?? (await getTokenBalance(tokenMint));
    if (amount === 0) return { success: false, error: 'Zero token balance' };

    logger.info('Executing sell', { token: tokenMint, amount });

    const { sellSlippageBps } = configManager.get().strategy;

    // Retry up to 3 times with backoff when getQuote returns null (404 / no route)
    const MAX_SELL_RETRIES = 3;
    const SELL_RETRY_DELAYS_MS = [5_000, 10_000, 15_000];
    let quote = await this.jupiter.getQuote(
      tokenMint,
      WSOL_MINT,
      BigInt(Math.floor(amount)),
      sellSlippageBps,
    );
    for (let attempt = 0; !quote && attempt < MAX_SELL_RETRIES; attempt++) {
      logger.warn('Sell quote returned null, retrying', {
        token: tokenMint,
        attempt: attempt + 1,
        maxRetries: MAX_SELL_RETRIES,
        delayMs: SELL_RETRY_DELAYS_MS[attempt],
      });
      await new Promise((r) => setTimeout(r, SELL_RETRY_DELAYS_MS[attempt]));
      quote = await this.jupiter.getQuote(
        tokenMint,
        WSOL_MINT,
        BigInt(Math.floor(amount)),
        sellSlippageBps,
      );
    }
    if (!quote) {
      logger.error('Sell quote failed after all retries', { token: tokenMint });
      return { success: false, error: 'Failed to get Jupiter quote for sell (all retries exhausted)' };
    }

    const txBuf = await this.jupiter.buildSwapTransaction(
      quote,
      wallet.publicKey.toBase58(),
      configManager.get().strategy.priorityFeeLamports,
    );
    if (!txBuf) return { success: false, error: 'Failed to build sell transaction' };

    try {
      const tx = deserializeVersionedTransaction(txBuf);
      const txSig = await sendAndConfirmVersionedTx(tx);
      const solReceived = Number(quote.outAmount) / LAMPORTS_PER_SOL;

      tradeLog('SELL_EXECUTED', {
        token: tokenMint,
        solReceived,
        tokensSold: amount,
        txSig,
      });

      return { success: true, txSig, solSpent: -solReceived, tokensReceived: 0 };
    } catch (err) {
      logger.error('Sell transaction failed', { token: tokenMint, err: String(err) });
      return { success: false, error: String(err) };
    }
  }
}
