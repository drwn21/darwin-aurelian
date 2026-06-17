import { TokenInfo, RiskScore, RiskLevel } from '../types/index.js';
import { MintAuthorityInfo } from '../utils/solana.js';
import { logger } from '../logger/Logger.js';

/** Score at/above which a token is flagged DANGER (independent of hard flags). */
const DANGER_SCORE = 60;
/** Score at/above which a token is flagged WARNING. */
const WARNING_SCORE = 30;
/** Liquidity must be at least this fraction of market cap, else THIN flag. */
const MIN_LIQ_TO_MCAP_RATIO = 0.12;

/**
 * Honeypot / rug detector built from GMGN token metadata.
 *
 * Produces a 0–100 risk score (higher = riskier), a list of human-readable
 * flags, a coarse {@link RiskLevel} (SAFE / WARNING / DANGER), and a hard
 * `isRug` boolean for instant rejection.
 *
 * `isRug` fires when a structural rug vector is present — an un-revoked mint
 * authority (devs can mint unlimited supply) or an un-revoked freeze authority
 * (devs can freeze your tokens so you can never sell). Either alone is enough.
 */
export class RugChecker {
  /**
   * @param token   GMGN-sourced token metadata.
   * @param onChain Authorities read directly from the mint account. When
   *   provided, these are the source of truth for the mint/freeze rug vectors
   *   (GMGN's renounce flags are often stale for fresh Pump.fun tokens). When
   *   `null`/omitted (RPC failed or not fetched), falls back to the API flags.
   */
  check(token: TokenInfo, onChain?: MintAuthorityInfo | null): RiskScore {
    const flags: string[] = [];
    let score = 0;

    // Authorities: prefer verified on-chain reads, fall back to API metadata.
    const mintRevoked = onChain ? onChain.mintAuthority === null : token.mintAuthRevoked;
    const freezeRevoked = onChain ? onChain.freezeAuthority === null : token.freezeAuthRevoked;

    // ── Structural rug vectors (authorities) ──────────────────────────────
    if (!mintRevoked) {
      flags.push('MINT_NOT_REVOKED');
      score += 40;
    }
    if (!freezeRevoked) {
      flags.push('FREEZE_NOT_REVOKED');
      score += 30;
    }

    // ── LP burn ───────────────────────────────────────────────────────────
    if (token.lpBurnedPercent < 50) {
      flags.push('LOW_LP_BURN');
      score += 20;
    } else if (token.lpBurnedPercent < 80) {
      flags.push('PARTIAL_LP_BURN');
      score += 10;
    }

    // ── Holder concentration ──────────────────────────────────────────────
    if (token.top10HolderPercent > 80) {
      flags.push('EXTREME_CONCENTRATION');
      score += 25;
    } else if (token.top10HolderPercent > 60) {
      flags.push('HIGH_CONCENTRATION');
      score += 15;
    }

    // ── Dev holdings ──────────────────────────────────────────────────────
    if (token.devHoldingPercent > 20) {
      flags.push('HIGH_DEV_HOLDING');
      score += 20;
    } else if (token.devHoldingPercent > 10) {
      flags.push('ELEVATED_DEV_HOLDING');
      score += 10;
    }

    // ── Holder count ──────────────────────────────────────────────────────
    if (token.holderCount < 30) {
      flags.push('VERY_FEW_HOLDERS');
      score += 15;
    } else if (token.holderCount < 100) {
      flags.push('FEW_HOLDERS');
      score += 5;
    }

    // ── Liquidity depth relative to market cap ────────────────────────────
    const liquidityRatio = token.liquidity / Math.max(token.marketCap, 1);
    if (liquidityRatio < 0.02) {
      flags.push('VERY_LOW_LIQUIDITY_RATIO');
      score += 15;
    } else if (liquidityRatio < MIN_LIQ_TO_MCAP_RATIO) {
      // Thin liquidity relative to mcap — easy to pump, hard to exit.
      flags.push('THIN_LIQUIDITY_RATIO');
      score += 15;
    }

    // ── Entrapment ratio ──────────────────────────────────────────────────
    // GMGN top-trader entrapment fraction — a high value means most buyers are
    // trapped (can't sell at profit), the hallmark of an engineered rug.
    const entrapment = token.entrapmentRatio ?? 0;
    const highEntrapment = entrapment > 0.15;
    if (highEntrapment) {
      flags.push('HIGH_ENTRAPMENT');
      score += 30;
    }

    // ── Suspicious composite patterns ─────────────────────────────────────
    score += this.patternScore(token, liquidityRatio, flags);

    const normalised = Math.min(Math.round(score), 100);

    // Either authority left live — or a high entrapment ratio — is a definite
    // rug vector on its own.
    const isRug = !mintRevoked || !freezeRevoked || highEntrapment;
    const level = this.levelFor(normalised, isRug);

    const result: RiskScore = { score: normalised, flags, isRug, level };

    const logPayload = {
      symbol: token.symbol,
      address: token.address,
      score: normalised,
      level,
      flags,
    };
    if (level === 'DANGER') logger.warn('RugChecker: DANGER', logPayload);
    else if (level === 'WARNING') logger.info('RugChecker: WARNING', logPayload);
    else logger.debug('RugChecker: SAFE', logPayload);

    return result;
  }

  /**
   * Combinations of signals that are individually tolerable but together look
   * like manipulation (wash trading, pump-and-dump setup, soft rug).
   */
  private patternScore(token: TokenInfo, liquidityRatio: number, flags: string[]): number {
    let extra = 0;

    // Sharp pump on thin liquidity — classic pump-and-dump setup.
    if (token.priceChange1h > 200 && liquidityRatio < 0.05) {
      flags.push('PUMP_ON_THIN_LIQUIDITY');
      extra += 15;
    }

    // High turnover with almost no holders → likely wash trading.
    if (token.volume24h > token.liquidity * 5 && token.holderCount < 50) {
      flags.push('WASH_TRADING_SUSPECTED');
      extra += 10;
    }

    // Dev still heavy AND LP not meaningfully burned → soft-rug risk.
    if (token.devHoldingPercent > 10 && token.lpBurnedPercent < 80) {
      flags.push('DEV_HEAVY_LOW_BURN');
      extra += 10;
    }

    // Concentrated supply alongside a meaningful dev bag → coordinated dump risk.
    if (token.top10HolderPercent > 70 && token.devHoldingPercent > 15) {
      flags.push('CONCENTRATED_PLUS_DEV');
      extra += 10;
    }

    return extra;
  }

  private levelFor(score: number, isRug: boolean): RiskLevel {
    if (isRug || score >= DANGER_SCORE) return 'DANGER';
    if (score >= WARNING_SCORE) return 'WARNING';
    return 'SAFE';
  }
}
