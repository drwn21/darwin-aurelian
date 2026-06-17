import * as crypto from 'crypto';
import * as dns from 'dns';
import axios, { AxiosInstance } from 'axios';
import { ENV } from '../config/config.js';
import { TokenInfo } from '../types/index.js';
import { logger } from '../logger/Logger.js';

// Force IPv4 — GMGN OpenAPI does not support IPv6
dns.setDefaultResultOrder('ipv4first');

const GMGN_BASE = 'https://openapi.gmgn.ai';

export class GmgnClient {
  private readonly http: AxiosInstance;
  private lastRequestAt = 0;
  private readonly requestDelayMs = 2500;

  constructor() {
    this.http = axios.create({
      baseURL: GMGN_BASE,
      timeout: 15_000,
      headers: {
        'X-APIKEY': ENV.gmgnApiKey ?? '',
        'Content-Type': 'application/json',
      },
    });
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.requestDelayMs) {
      await new Promise(r => setTimeout(r, this.requestDelayMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private extraParams(): Record<string, string> {
    return {
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: crypto.randomUUID(),
    };
  }

  async fetchRankedTokens(opts: {
    interval?: string;
    orderBy?: string;
    direction?: string;
    limit?: number;
  } = {}): Promise<TokenInfo[]> {
    const params = {
      chain: 'sol',
      interval: opts.interval ?? '5m',
      order_by: opts.orderBy ?? 'creation_timestamp',
      direction: opts.direction ?? 'desc',
      limit: String(Math.min(100, opts.limit ?? 50)),
      ...this.extraParams(),
    };

    try {
      await this.pace();
      const { data } = await this.http.get('/v1/market/rank', { params });
      const list = this.unwrapList(data);
      logger.info('GmgnClient.fetchRankedTokens', { count: list.length });
      if (list.length > 0) {
        const first = list[0];
        logger.debug('GmgnClient.firstToken', { 
          symbol: first.symbol, 
          open_timestamp: first.open_timestamp,
          creation_timestamp: first.creation_timestamp,
          market_cap: first.market_cap 
        });
      }
      return list.map(raw => this.mapToTokenInfo(raw));
    } catch (err: any) {
      logger.warn('GmgnClient.fetchRankedTokens failed', {
        status: err.response?.status,
        err: err.message,
      });
      return [];
    }
  }

  /**
   * Fetch trenches / near-completion bonding-curve tokens (pre-bond, MC ≈ $0).
   *
   * These live before a DEX pool exists, so the rank feed's market_cap is
   * absent — every result is tagged `isTrenches: true` so downstream screening
   * skips the market-cap gate and leans on liquidity / signals instead.
   *
   * Mirrors fetchRankedTokens' resilience: any failure (endpoint missing on a
   * given GMGN deployment, network error) returns `[]` rather than throwing, so
   * enabling trenches mode can never break the discovery loop.
   */
  async fetchTrenchesTokens(opts: { limit?: number } = {}): Promise<TokenInfo[]> {
    const params = {
      chain: 'sol',
      type: 'new_creation,near_completion',
      order_by: 'holder_count',
      direction: 'desc',
      limit: String(Math.min(100, opts.limit ?? 80)),
      ...this.extraParams(),
    };

    try {
      await this.pace();
      const { data } = await this.http.get('/v1/market/trenches', { params });
      const list = this.unwrapTrenches(data);
      logger.info('GmgnClient.fetchTrenchesTokens', { count: list.length });
      return list.map(raw => ({ ...this.mapToTokenInfo(raw), isTrenches: true }));
    } catch (err: any) {
      logger.warn('GmgnClient.fetchTrenchesTokens failed', {
        status: err.response?.status,
        err: err.message,
      });
      return [];
    }
  }

  async fetchTokenInfo(address: string): Promise<TokenInfo | null> {
    const params = {
      chain: 'sol',
      address,
      ...this.extraParams(),
    };

    try {
      await this.pace();
      const { data } = await this.http.get('/v1/token/info', { params });
      const raw = data?.data?.data || data?.data || data;
      return raw?.address ? this.mapToTokenInfo(raw) : null;
    } catch (err: any) {
      logger.warn('GmgnClient.fetchTokenInfo failed', {
        address,
        status: err.response?.status,
        err: err.message,
      });
      return null;
    }
  }

  async fetchTopHolders(address: string): Promise<any[]> {
    const params = {
      chain: 'sol',
      address,
      limit: '20',
      ...this.extraParams(),
    };

    try {
      await this.pace();
      const { data } = await this.http.get('/v1/market/token_top_holders', { params });
      return this.unwrapList(data);
    } catch (err: any) {
      logger.warn('GmgnClient.fetchTopHolders failed', { address, err: err.message });
      return [];
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Overlay /v1/token/info enrichment onto a base record from the rank feed.
   *
   * The rank feed is the source of truth — it always carries market_cap, price
   * and volume. The token-info feed lacks market_cap, so it must NEVER overwrite
   * existing values; it only *fills in* fields that are blank (null / undefined /
   * 0 / '' / false) on the base record. This guarantees the rank feed's
   * market_cap can never be clobbered during enrichment.
   */
  static mergeEnrichment(base: TokenInfo, detail: TokenInfo | null): TokenInfo {
    if (!detail) return { ...base };

    const merged: Record<string, any> = { ...base };
    const isBlank = (v: any) => v == null || v === 0 || v === '' || v === false;

    // Fields the rank feed owns. They must never be overwritten by token/info
    // when the rank feed has a real value — token/info derives market_cap from
    // supply×price and can disagree, which is what produced "MC=N/A on the first
    // signal, MC present on the second". We snapshot them, do the generic
    // gap-fill, then restore so no key order or isBlank edge case can clobber
    // a known rank value.
    const RANK_OWNED = ['marketCap', 'price', 'volume24h', 'volume1h', 'liquidity'] as const;
    const rankAuthoritative: Record<string, any> = {};
    for (const key of RANK_OWNED) {
      if (!isBlank((base as Record<string, any>)[key])) {
        rankAuthoritative[key] = (base as Record<string, any>)[key];
      }
    }

    // Generic gap-fill: token/info only *fills in* fields blank on the base.
    for (const [key, value] of Object.entries(detail)) {
      if (isBlank(value)) continue;                  // nothing useful to add
      if (isBlank(merged[key])) merged[key] = value; // only fill gaps, never override
    }

    // Restore rank-authoritative values: if the rank feed had a real market cap
    // (or price/volume/liquidity), that always wins over enrichment.
    Object.assign(merged, rankAuthoritative);

    return merged as TokenInfo;
  }

  /**
   * Trenches feed returns two buckets — `new_creation` and `near_completion`.
   * Flatten them into one address-deduplicated list (new_creation wins ties).
   */
  private unwrapTrenches(payload: any): any[] {
    const d = payload?.data?.data ?? payload?.data ?? payload ?? {};
    const buckets = [d.new_creation, d.near_completion];
    const seen = new Set<string>();
    const out: any[] = [];
    for (const bucket of buckets) {
      if (!Array.isArray(bucket)) continue;
      for (const t of bucket) {
        const addr = t?.address || t?.base_address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        out.push(t);
      }
    }
    // Some deployments may return a flat list/rank shape — fall back to that.
    if (out.length === 0) return this.unwrapList(payload);
    return out;
  }

  private unwrapList(payload: any): any[] {
    const d = payload?.data;
    if (!d) return [];
    const nested = d?.data;
    if (nested?.rank && Array.isArray(nested.rank)) return nested.rank;
    if (d?.rank && Array.isArray(d.rank)) return d.rank;
    if (d?.list && Array.isArray(d.list)) return d.list;
    if (Array.isArray(nested)) return nested;
    if (Array.isArray(d)) return d;
    return [];
  }

  private num(val: any): number {
    if (val == null) return 0;
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
  }

  private mapToTokenInfo(raw: any): TokenInfo {
    // Handle nested price object from /v1/token/info API
    const priceObj = typeof raw.price === 'object' ? raw.price : null;
    const price = priceObj ? this.num(priceObj.price) : this.num(raw.price || raw.price_usd);

    // market_cap / fdv come straight from the rank feed. /v1/token/info has no
    // market_cap, and brand-new rank tokens occasionally omit it too — in both
    // cases derive it from total_supply × price. This works regardless of
    // whether the price arrived as a scalar (rank) or nested object (info).
    const supply = this.num(raw.total_supply || raw.circulating_supply);
    const marketCap = this.num(raw.market_cap || raw.fdv) || (supply && price ? supply * price : 0);

    return {
      address: raw.address || raw.base_address || '',
      symbol: raw.symbol || raw.base_symbol || '?',
      name: raw.name || raw.symbol || '?',
      decimals: Number(raw.decimals ?? 9),
      price,
      marketCap,
      liquidity: this.num(raw.liquidity),
      volume1h: priceObj ? this.num(priceObj.volume_1h) : this.num(raw.volume_1h || raw.volume_1h_usd),
      volume24h: priceObj ? this.num(priceObj.volume_24h) : this.num(raw.volume || raw.volume_24h),
      priceChange5m: priceObj ? this.num(priceObj.price_5m) : this.num(raw.price_change_percent_5m || raw.price_change_5m),
      priceChange1h: priceObj ? this.num(priceObj.price_1h) : this.num(raw.price_change_percent_1h || raw.price_change_1h),
      holderCount: this.num(raw.holder_count || raw.holders),
      createdAt: this.num(raw.open_timestamp || raw.creation_timestamp || raw.creation_time),
      mintAuthRevoked: raw.renounced_mint === 1,
      freezeAuthRevoked: raw.renounced_freeze_account === 1,
      lpBurned: this.num(raw.burn_ratio) > 0,
      lpBurnedPercent: this.num(raw.burn_ratio),
      isHoneypot: raw.is_honeypot === 1,
      isWashTrading: raw.is_wash_trading === true,
      devHoldingPercent: this.num(raw.dev_team_hold_rate) * 100,
      top10HolderPercent: this.num(raw.top_10_holder_rate),
      bundlerRate: this.num(raw.bundler_rate),
      freshWalletRate: this.num(raw.fresh_wallet_rate),
      devTeamHoldRate: this.num(raw.dev_team_hold_rate),
      buys: priceObj ? this.num(priceObj.buys_1h) : this.num(raw.buys || raw.swap_count_buys),
      sells: priceObj ? this.num(priceObj.sells_1h) : this.num(raw.sells || raw.swap_count_sells),
      washTrading: Boolean(raw.wash_trading || raw.is_wash_trading),
      // Pre-pump / quality signals — default to 0 when the feed omits them.
      entrapmentRatio: this.num(raw.entrapment_ratio),
      smartDegenCount: this.num(raw.smart_degen_count),
      sniperCount: this.num(raw.sniper_count),
      hotLevel: this.num(raw.hot_level),
      creatorHoldRate: this.num(raw.creator_hold_rate || raw.creator_token_hold_rate),
      buys24h: this.num(raw.buys_24h || raw.buys),
      sells24h: this.num(raw.sells_24h || raw.sells),
      renownedCount: this.num(raw.renowned_count),
    };
  }
}
