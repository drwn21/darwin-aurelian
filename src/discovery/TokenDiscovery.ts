import EventEmitter from 'events';
import { GmgnClient } from './GmgnClient.js';
import { TokenInfo } from '../types/index.js';
import { DISCOVERY_INTERVAL_MS } from '../config/constants.js';
import { configManager } from '../config/ConfigManager.js';
import { logger } from '../logger/Logger.js';
import { themeKey } from '../screening/themeKey.js';
import { OriginalityScorer } from '../screening/OriginalityScorer.js';

/** How long an address stays deduplicated after it was last emitted. */
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes — allow re-entry after position closes

/** How long a token stays in the cohort buffer, in ms. */
const COHORT_WINDOW_MS = 180_000; // 3 min

/** Minimum time since first-seen before a singleton is emitted, in ms. */
const SINGLETON_DELAY_MS = 45_000; // 3 poll cycles @ 15s

/** Default block duration for a cohort after a negative trade outcome. */
const COHORT_BLOCK_DEFAULT_MS = 30 * 60 * 1000; // 30 min

export interface TokenDiscoveryOptions {
  /** Poll interval in ms (default: DISCOVERY_INTERVAL_MS = 15s). */
  intervalMs?: number;
  /** How many new-pair tokens to request per poll. */
  newTokensLimit?: number;
  /** How many trending tokens to request per poll. */
  trendingLimit?: number;
  /** Dedupe window in ms (default 1 hour). */
  dedupeTtlMs?: number;
}

export declare interface TokenDiscovery {
  on(event: 'candidate', listener: (token: TokenInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  emit(event: 'candidate', token: TokenInfo): boolean;
  emit(event: 'error', err: Error): boolean;
}

/**
 * Polling orchestrator over GmgnClient.
 *
 * On each tick it pulls ranked tokens, groups them by theme cohort, runs
 * originality scoring on multi-token cohorts, and emits a 'candidate' event
 * for the cohort winner (or a singleton after a brief hold period).
 *
 * Polls never overlap: if a tick is still running when the timer fires, the
 * new tick is skipped.
 */
export class TokenDiscovery extends EventEmitter {
  readonly client: GmgnClient;
  private readonly intervalMs: number;
  private readonly dedupeTtlMs: number;

  /** address → last-emitted unix ms. */
  private readonly seen = new Map<string, number>();

  /** themeKey → [{token, seenAt}]: accumulates candidates across polls. */
  private readonly cohortBuffer = new Map<string, { token: TokenInfo; seenAt: number }[]>();

  /** themeKey → blocked-until timestamp. Cohort blocked after negative trade outcome. */
  private readonly cohortBlockMap = new Map<string, number>();

  private readonly scorer = new OriginalityScorer();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;

  constructor(client?: GmgnClient, options: TokenDiscoveryOptions = {}) {
    super();
    this.client = client ?? new GmgnClient();
    this.intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEDUPE_TTL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('TokenDiscovery started', { intervalMs: this.intervalMs });
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    // Don't keep the event loop alive solely for discovery polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('TokenDiscovery stopped');
  }

  /** True while a poll cycle is in flight. */
  isRunning(): boolean {
    return this.running;
  }

  /** Number of addresses currently inside the dedupe window. */
  get trackedCount(): number {
    return this.seen.size;
  }

  /** Force-forget an address so it can be re-emitted immediately. */
  forget(address: string): void {
    this.seen.delete(address);
  }

  /** Block all tokens sharing the same themeKey for a duration (default 30 min). */
  blockCohort(key: string, durationMs = COHORT_BLOCK_DEFAULT_MS): void {
    const until = Date.now() + durationMs;
    this.cohortBlockMap.set(key, until);
    logger.info('Cohort blocked', { themeKey: key, until: new Date(until).toISOString() });
  }

  /** Look up the themeKey for a token address currently in the cohort buffer. */
  findThemeKeyForAddress(address: string): string | null {
    for (const [key, entries] of this.cohortBuffer) {
      if (entries.some(e => e.token.address === address)) return key;
    }
    return null;
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      logger.debug('TokenDiscovery: previous poll still running, skipping tick');
      return;
    }
    this.polling = true;
    const startedAt = Date.now();

    try {
      const tokens = await this.client.fetchRankedTokens({
        interval: '5m',
        orderBy: 'volume',
        direction: 'desc',
        limit: 50,
      });

      const now = Date.now();
      this.prune(now);
      this.pruneCohortBuffer(now);

      // Deduplicate within this poll by address.
      const unique = new Map<string, TokenInfo>();
      for (const token of tokens) {
        if (token?.address) unique.set(token.address, token);
      }

      // Add all fetched tokens to the cohort buffer (update data, keep seenAt).
      for (const token of unique.values()) {
        const key = themeKey(token);
        const entries = this.cohortBuffer.get(key) ?? [];
        const idx = entries.findIndex(e => e.token.address === token.address);
        if (idx >= 0) {
          entries[idx].token = token; // refresh with latest data
        } else {
          entries.push({ token, seenAt: now });
        }
        this.cohortBuffer.set(key, entries);
      }

      // Resolve thresholds from live config, falling back to module constants.
      const origCfg = configManager.get().screening.originality;
      const singletonDelayMs = origCfg?.singletonDelayMs ?? SINGLETON_DELAY_MS;

      let emitted = 0;

      for (const [key, entries] of this.cohortBuffer) {
        // Skip blocked cohorts.
        const blockedUntil = this.cohortBlockMap.get(key);
        if (blockedUntil && now < blockedUntil) {
          logger.info('Cohort blocked — skipping', { themeKey: key, blockedUntil });
          continue;
        }
        if (blockedUntil && now >= blockedUntil) {
          this.cohortBlockMap.delete(key); // expired
        }

        if (entries.length >= 2) {
          const cohortTokens = entries.map(e => e.token);
          const result = this.scorer.score(cohortTokens);

          logger.info('TokenDiscovery cohort analysis', {
            themeKey: key,
            cohortSize: entries.length,
            winner: result.winner?.token.symbol ?? null,
            winnerScore: result.winner?.breakdown.total ?? null,
            ranked: result.ranked.map(r => ({ sym: r.token.symbol, score: r.breakdown.total })),
          });

          if (result.winner) {
            const { token: winnerToken } = result.winner;
            if (!this.isRecentlySeen(winnerToken.address, now)) {
              this.seen.set(winnerToken.address, now);
              this.safeEmit(winnerToken);
              emitted++;
            }
          }
        } else {
          // Singleton: hold for singletonDelayMs to allow siblings to appear.
          // Then apply STRICTER quality gates — without siblings for comparison,
          // we can't rely on originality score alone. A lone token with bad
          // distribution metrics is more likely a rug than a winner.
          const entry = entries[0];
          if (now - entry.seenAt >= singletonDelayMs) {
            if (!this.isRecentlySeen(entry.token.address, now)) {
              const t = entry.token;
              const top10 = (t.top10HolderPercent ?? 0) * 100;
              const fresh = (t.freshWalletRate ?? 0) * 100;
              const entrap = (t.entrapmentRatio ?? 0) * 100;
              const holders = t.holderCount ?? 0;

              const fails: string[] = [];
              if (top10 > 50) fails.push(`top10 ${top10.toFixed(0)}% > 50%`);
              if (fresh > 80) fails.push(`fresh ${fresh.toFixed(0)}% > 80%`);
              if (holders < 80) fails.push(`holders ${holders} < 80`);
              if (entrap > 10) fails.push(`entrap ${entrap.toFixed(0)}% > 10%`);

              if (fails.length > 0) {
                logger.info('Singleton rejected — quality gate failed', {
                  symbol: t.symbol,
                  address: t.address,
                  fails,
                });
              } else {
                this.seen.set(entry.token.address, now);
                this.safeEmit(entry.token);
                emitted++;
              }
            }
          }
        }
      }

      logger.debug('TokenDiscovery poll complete', {
        fetched: unique.size,
        cohorts: this.cohortBuffer.size,
        emitted,
        tracked: this.seen.size,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('TokenDiscovery poll failed', { err: error.message });
      this.emit('error', error);
    } finally {
      this.polling = false;
    }
  }

  private isRecentlySeen(address: string, now: number): boolean {
    const lastSeen = this.seen.get(address);
    return lastSeen !== undefined && now - lastSeen < this.dedupeTtlMs;
  }

  /** Emit a candidate without letting a listener exception break the loop. */
  private safeEmit(token: TokenInfo): void {
    try {
      this.emit('candidate', token);
    } catch (err) {
      logger.error('TokenDiscovery candidate listener threw', {
        token: token.address,
        err: String(err),
      });
    }
  }

  /** Drop addresses whose dedupe window has fully elapsed. */
  private prune(now: number): void {
    for (const [address, lastSeen] of this.seen) {
      if (now - lastSeen >= this.dedupeTtlMs) {
        this.seen.delete(address);
      }
    }
  }

  /** Remove cohort buffer entries older than COHORT_WINDOW_MS. */
  private pruneCohortBuffer(now: number): void {
    const windowMs = configManager.get().screening.originality?.cohortWindowMs ?? COHORT_WINDOW_MS;
    for (const [key, entries] of this.cohortBuffer) {
      const fresh = entries.filter(e => now - e.seenAt < windowMs);
      if (fresh.length === 0) {
        this.cohortBuffer.delete(key);
      } else {
        this.cohortBuffer.set(key, fresh);
      }
    }
  }
}
