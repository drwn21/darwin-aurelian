import axios, { AxiosRequestConfig } from 'axios';
import { JUPITER_QUOTE_URL, JUPITER_SWAP_URL, JUPITER_PRICE_URL, WSOL_MINT, LAMPORTS_PER_SOL } from '../config/constants.js';
import { ENV } from '../config/config.js';
import { JupiterQuote } from '../types/index.js';
import { logger } from '../logger/Logger.js';

// Jupiter Pro API endpoints (used when JUPITER_API_KEY is set)
const JUPITER_PRO_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_PRO_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

interface JupiterSwapPayload {
  quoteResponse: JupiterQuote;
  userPublicKey: string;
  wrapAndUnwrapSol: boolean;
  dynamicComputeUnitLimit: boolean;
  prioritizationFeeLamports: number;
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64 encoded
  lastValidBlockHeight: number;
}

interface JupiterPriceResponse {
  data: Record<string, { id: string; mintSymbol: string; vsToken: string; price: number }>;
}

export class JupiterClient {
  private get apiKey(): string | undefined {
    return ENV.jupiterApiKey;
  }

  private get quoteUrl(): string {
    return this.apiKey ? JUPITER_PRO_QUOTE_URL : JUPITER_QUOTE_URL;
  }

  private get swapUrl(): string {
    return this.apiKey ? JUPITER_PRO_SWAP_URL : JUPITER_SWAP_URL;
  }

  /** Build request config with API key header if available. */
  private requestConfig(extra?: AxiosRequestConfig): AxiosRequestConfig {
    const cfg: AxiosRequestConfig = { ...extra };
    if (this.apiKey) {
      cfg.headers = { ...cfg.headers, 'x-api-key': this.apiKey };
    }
    return cfg;
  }

  /**
   * Pull the HTTP status and a searchable error string out of an unknown error.
   * Jupiter returns error details in the response body (e.g. `errorCode` /
   * `error` fields), so we fold the body into the text we scan for known codes.
   */
  private parseError(err: unknown): { status?: number; text: string } {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');
      return { status, text: `${err.message} ${bodyText}` };
    }
    return { text: String(err) };
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint,
    slippageBps: number,
  ): Promise<JupiterQuote | null> {
    try {
      const res = await axios.get<JupiterQuote>(this.quoteUrl, this.requestConfig({
        params: {
          inputMint,
          outputMint,
          amount: amountLamports.toString(),
          slippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
        timeout: 10_000,
      }));
      return res.data;
    } catch (err) {
      const { status, text } = this.parseError(err);
      if (text.includes('NO_ROUTES_FOUND')) {
        logger.warn('Jupiter getQuote: no routes found — skipping token', { inputMint, outputMint });
        return null;
      }
      if (status === 429) {
        logger.warn('Jupiter getQuote: rate limited (429)', { inputMint, outputMint });
        return null;
      }
      if (/price impact/i.test(text)) {
        logger.warn('Jupiter getQuote: price impact too high', { inputMint, outputMint, err: text });
        return null;
      }
      logger.error('Jupiter getQuote failed', { inputMint, outputMint, err: text });
      return null;
    }
  }

  async buildSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    priorityFeeLamports: number,
  ): Promise<Buffer | null> {
    try {
      const payload: JupiterSwapPayload = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeLamports,
      };
      const res = await axios.post<JupiterSwapResponse>(this.swapUrl, payload, this.requestConfig({
        timeout: 15_000,
      }));
      return Buffer.from(res.data.swapTransaction, 'base64');
    } catch (err) {
      const { status, text } = this.parseError(err);
      if (text.includes('TRANSFER_FROM_FAILED')) {
        logger.warn('Jupiter buildSwapTransaction: TRANSFER_FROM_FAILED — token approval/transfer issue', { err: text });
        return null;
      }
      if (/simulation/i.test(text)) {
        logger.warn('Jupiter buildSwapTransaction: simulation failed — possible honeypot (tax/restricted token)', { err: text });
        return null;
      }
      if (status === 429) {
        logger.warn('Jupiter buildSwapTransaction: rate limited (429)', {});
        return null;
      }
      logger.error('Jupiter buildSwapTransaction failed', { err: text });
      return null;
    }
  }

  /**
   * Anti-honeypot probe: quote selling `tokenAmountBaseUnits` of `tokenMint`
   * back to SOL and return the route's price impact as a **percentage**
   * (Jupiter reports `priceImpactPct` as a fraction where 1.0 = 100%).
   *
   * Returns `null` when no route exists / the quote fails — callers should
   * treat that as un-sellable (honeypot), not as zero impact.
   */
  async getSellPriceImpactPct(
    tokenMint: string,
    tokenAmountBaseUnits: bigint,
    slippageBps: number,
  ): Promise<number | null> {
    const quote = await this.getQuote(tokenMint, WSOL_MINT, tokenAmountBaseUnits, slippageBps);
    if (!quote) return null;
    const fraction = parseFloat(quote.priceImpactPct);
    if (!Number.isFinite(fraction)) return null;
    return fraction * 100;
  }

  /**
   * Get the **USD** price for one or more token mints via Jupiter price API.
   *
   * Returns USD per whole token (decimal-adjusted). For PnL the bot tracks
   * positions in SOL terms — use {@link getPriceInSol} instead, which divides
   * these USD prices by the live SOL/USD price so a SOL move doesn't distort
   * token PnL.
   */
  async getPrice(mints: string[]): Promise<Record<string, number>> {
    try {
      const res = await axios.get<JupiterPriceResponse>(JUPITER_PRICE_URL, this.requestConfig({
        params: { ids: mints.join(',') },
        timeout: 8_000,
      }));
      const result: Record<string, number> = {};
      for (const [mint, info] of Object.entries(res.data.data)) {
        // Price v2 returns `price` as a string — coerce to a number.
        const price = Number(info.price);
        if (Number.isFinite(price)) result[mint] = price;
      }
      return result;
    } catch {
      return {};
    }
  }

  /** Live SOL/USD price (USD per 1 SOL), or null if it can't be fetched. */
  async getSolUsdPrice(): Promise<number | null> {
    const prices = await this.getPrice([WSOL_MINT]);
    const sol = prices[WSOL_MINT];
    return Number.isFinite(sol) && sol > 0 ? sol : null;
  }

  /**
   * Get **SOL-denominated** prices (SOL per whole token) for one or more mints.
   *
   * Fetches the tokens' USD prices and the SOL/USD price in a single request
   * (WSOL is appended to the id list) and returns `tokenUSD / solUSD`. Tracking
   * PnL in SOL terms means a drop in SOL price doesn't show up as token loss:
   * if a token holds its SOL value, its PnL stays flat even as USD falls.
   *
   * Returns `{}` when the SOL price is unavailable (we can't convert safely);
   * mints with no USD price are simply omitted.
   */
  /**
   * Fallback price source: derive SOL per whole token from a Jupiter **swap
   * quote** rather than the Price API. Quotes selling 1 whole token to SOL and
   * returns `outSol / inTokens`.
   *
   * Works for any token Jupiter can route — including brand-new Pump.fun
   * bonding-curve tokens that the Price API / CoinGecko don't index yet. It's a
   * full quote (slower than a price lookup), so callers should only reach for it
   * after the Price API has missed. Returns `null` when no route exists.
   */
  async quotePriceInSol(mint: string, decimals: number): Promise<number | null> {
    const dec = Number.isFinite(decimals) && decimals >= 0 ? Math.floor(decimals) : 0;
    const amount = BigInt(10) ** BigInt(dec); // 1 whole token in base units
    if (amount <= 0n) return null;
    const quote = await this.getQuote(mint, WSOL_MINT, amount, 500);
    if (!quote) return null;
    const inTokens = Number(quote.inAmount) / 10 ** dec;
    const outSol = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    if (!(inTokens > 0) || !(outSol > 0)) return null;
    return outSol / inTokens;
  }

  async getPriceInSol(mints: string[]): Promise<Record<string, number>> {
    const usd = await this.getPrice([...mints, WSOL_MINT]);
    const solUsd = usd[WSOL_MINT];
    if (!Number.isFinite(solUsd) || solUsd <= 0) return {};

    const result: Record<string, number> = {};
    for (const mint of mints) {
      const tokenUsd = usd[mint];
      if (Number.isFinite(tokenUsd) && tokenUsd > 0) {
        result[mint] = tokenUsd / solUsd;
      }
    }
    return result;
  }
}
