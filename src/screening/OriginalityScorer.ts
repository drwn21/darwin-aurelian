import { TokenInfo } from '../types/index.js';
import { configManager } from '../config/ConfigManager.js';

export interface OriginalityBreakdown {
  firstMover: number;     // 0-25: earliest creation_timestamp in cohort
  holderLead: number;     // 0-20: holders relative to cohort max
  liquidityLead: number;  // 0-15: liquidity relative to cohort max
  smartMoney: number;     // 0-15: smart-degen + renowned wallet count
  distribution: number;   // 0-15: penalised for concentration / wash signals
  momentum: number;       // 0-10: volume lead × buy pressure
  total: number;          // 0-100
  cohortSize: number;
  isLikelyOriginal: boolean;
}

export interface OriginalityResult {
  ranked: Array<{ token: TokenInfo; breakdown: OriginalityBreakdown }>;
  winner: { token: TokenInfo; breakdown: OriginalityBreakdown } | null;
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export class OriginalityScorer {
  score(cohort: TokenInfo[]): OriginalityResult {
    if (cohort.length === 0) return { ranked: [], winner: null };

    const cfg = configManager.get().screening.originality ?? { minScore: 60, minMargin: 12 };

    const maxHolders = Math.max(...cohort.map(t => t.holderCount));
    const maxLiquidity = Math.max(...cohort.map(t => t.liquidity));
    const maxVolume = Math.max(...cohort.map(t => t.volume24h));

    // Rank by creation timestamp ascending: rank 0 = earliest = best firstMover.
    const sortedByAge = [...cohort].sort((a, b) => a.createdAt - b.createdAt);
    const ageRank = new Map<string, number>(sortedByAge.map((t, i) => [t.address, i]));

    const ranked = cohort.map(token => {
      const breakdown = this.scoreToken(
        token, cohort.length, ageRank, maxHolders, maxLiquidity, maxVolume,
      );
      return { token, breakdown };
    });

    ranked.sort((a, b) => b.breakdown.total - a.breakdown.total);

    let winner: { token: TokenInfo; breakdown: OriginalityBreakdown } | null = null;

    if (cohort.length === 1) {
      const candidate = ranked[0];
      if (candidate.breakdown.total >= cfg.minScore) {
        candidate.breakdown.isLikelyOriginal = true;
        winner = candidate;
      }
    } else {
      const first = ranked[0];
      const second = ranked[1];
      const margin = first.breakdown.total - second.breakdown.total;
      if (first.breakdown.total >= cfg.minScore && margin >= cfg.minMargin) {
        first.breakdown.isLikelyOriginal = true;
        winner = first;
      }
    }

    return { ranked, winner };
  }

  private scoreToken(
    token: TokenInfo,
    cohortSize: number,
    ageRank: Map<string, number>,
    maxHolders: number,
    maxLiquidity: number,
    maxVolume: number,
  ): OriginalityBreakdown {
    const rank = ageRank.get(token.address) ?? cohortSize - 1;
    const firstMover = cohortSize > 1
      ? clamp(25 * (1 - rank / (cohortSize - 1)), 0, 25)
      : 25;

    const holderLead = maxHolders > 0
      ? clamp((token.holderCount / maxHolders) * 20, 0, 20)
      : 0;

    const liquidityLead = maxLiquidity > 0
      ? clamp((token.liquidity / maxLiquidity) * 15, 0, 15)
      : 0;

    const smartDegen = token.smartDegenCount ?? 0;
    const renowned = token.renownedCount ?? 0;
    const smartMoney = clamp((smartDegen + renowned) * 5, 0, 15);

    let distribution = 15;
    if ((token.top10HolderPercent ?? 0) > 35) distribution -= 4;
    if ((token.freshWalletRate ?? 0) > 0.5) distribution -= 4;
    if ((token.bundlerRate ?? 0) > 0.3) distribution -= 4;
    if ((token.entrapmentRatio ?? 0) > 0.08) distribution -= 3;
    distribution = clamp(distribution, 0, 15);

    const volumeLead = maxVolume > 0 ? clamp(token.volume24h / maxVolume, 0, 1) : 0;
    const buys = token.buys ?? 0;
    const sells = token.sells ?? 0;
    const buyPressure = (buys + sells) > 0 ? clamp(buys / (buys + sells), 0, 1) : 0;
    const momentum = clamp((volumeLead * 0.6 + buyPressure * 0.4) * 10, 0, 10);

    const total = clamp(
      Math.round(firstMover + holderLead + liquidityLead + smartMoney + distribution + momentum),
      0,
      100,
    );

    return {
      firstMover: Math.round(firstMover * 10) / 10,
      holderLead: Math.round(holderLead * 10) / 10,
      liquidityLead: Math.round(liquidityLead * 10) / 10,
      smartMoney,
      distribution,
      momentum: Math.round(momentum * 10) / 10,
      total,
      cohortSize,
      isLikelyOriginal: false,
    };
  }
}
