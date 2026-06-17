import { GmgnSnapshot } from '../types/index.js';
import { GmgnClient } from '../discovery/GmgnClient.js';
import { logger } from '../logger/Logger.js';

/** Outcome of a runtime rug-signal comparison against the entry snapshot. */
export interface RugSignalResult {
  isRug: boolean;
  signals: string[];
  rugScore: number;
}

/** Score at/above which the aggregate signals are treated as a rug. */
const RUG_SCORE_THRESHOLD = 30;

/**
 * Runtime rug detector. Compares a position's current GMGN metrics against the
 * snapshot captured at entry and scores divergences that look like an active
 * rug (holder exodus, top-10 consolidation, liquidity drain, entrapment spike,
 * creator over-concentration, all-fresh-wallet farms).
 *
 * A token is flagged a rug once the aggregate score reaches
 * {@link RUG_SCORE_THRESHOLD} (one strong signal, or several weak ones). API
 * failures never flag a rug — they return a neutral, non-rug result so the
 * position keeps riding its normal TP/SL logic.
 */
export class RugSignalDetector {
  private client: GmgnClient;

  constructor(client?: GmgnClient) {
    this.client = client ?? new GmgnClient();
  }

  async checkRugSignals(
    tokenAddress: string,
    snapshot: GmgnSnapshot | undefined,
    symbol = 'Unknown',
  ): Promise<RugSignalResult> {
    if (!snapshot) return { isRug: false, signals: [], rugScore: 0 };

    const signals: string[] = [];
    let rugScore = 0;

    try {
      const cur = await this.client.fetchTokenInfo(tokenAddress);
      if (!cur) return { isRug: false, signals: [], rugScore: 0 };

      const curHolders = cur.holderCount || 0;
      const curTop10 = cur.top10HolderPercent || 0;       // 0-1 fraction
      const curLiq = cur.liquidity || 0;                  // USD
      const curEntrapment = cur.entrapmentRatio || 0;     // 0-1 fraction
      const curCreatorHold = cur.creatorHoldRate || 0;    // 0-1 fraction
      const curFreshWallet = cur.freshWalletRate || 0;    // 0-1 fraction

      // Signal 1: holder exodus (>40% drop from entry).
      if (snapshot.holders > 10 && curHolders > 0) {
        const holderDrop = ((snapshot.holders - curHolders) / snapshot.holders) * 100;
        if (holderDrop > 40) {
          signals.push(`Holders dropped ${holderDrop.toFixed(0)}% (${snapshot.holders} → ${curHolders})`);
          rugScore += 30;
        }
      }

      // Signal 2: top-10 holder consolidation (>50% spike from entry).
      if (snapshot.top10 > 0 && curTop10 > 0) {
        const top10Spike = ((curTop10 - snapshot.top10) / snapshot.top10) * 100;
        if (top10Spike > 50) {
          signals.push(
            `Top10 holders spiked ${top10Spike.toFixed(0)}% ` +
              `(${(snapshot.top10 * 100).toFixed(1)}% → ${(curTop10 * 100).toFixed(1)}%)`,
          );
          rugScore += 30;
        }
      }

      // Signal 3: liquidity drain (>50% drop from entry). Skipped when current
      // liq reads 0 against a tiny entry liq — that's a pre-bond token with no
      // DEX pool yet, not a drain (false positive).
      if (snapshot.liquidity > 1000 && curLiq > 0) {
        const liqDrop = ((snapshot.liquidity - curLiq) / snapshot.liquidity) * 100;
        if (liqDrop > 50) {
          signals.push(
            `Liquidity dropped ${liqDrop.toFixed(0)}% ` +
              `($${(snapshot.liquidity / 1000).toFixed(1)}K → $${(curLiq / 1000).toFixed(1)}K)`,
          );
          rugScore += 30;
        }
      }

      // Signal 4: entrapment spike (was low at entry, now high).
      if (curEntrapment > 0.15 && snapshot.entrapment < 0.05) {
        signals.push(
          `Entrapment spiked to ${(curEntrapment * 100).toFixed(1)}% ` +
            `(was ${(snapshot.entrapment * 100).toFixed(1)}%)`,
        );
        rugScore += 20;
      }

      // Signal 5: creator now holds >90% of supply.
      if (curCreatorHold > 0.9) {
        signals.push(`Creator holds ${(curCreatorHold * 100).toFixed(1)}% of supply`);
        rugScore += 25;
      }

      // Signal 6: >95% fresh wallets (possible bot/fake holders).
      if (curFreshWallet > 0.95) {
        signals.push(`${(curFreshWallet * 100).toFixed(0)}% fresh wallets (possible bot/fake wallets)`);
        rugScore += 15;
      }

      return { isRug: rugScore >= RUG_SCORE_THRESHOLD, signals, rugScore };
    } catch (e: any) {
      // Never block on API errors.
      logger.warn('RugSignalDetector: check failed', { token: tokenAddress, symbol, err: e?.message ?? String(e) });
      return { isRug: false, signals: [], rugScore: 0 };
    }
  }
}
