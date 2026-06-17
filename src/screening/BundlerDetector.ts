import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { ENV } from '../config/config.js';
import { logger } from '../logger/Logger.js';

/**
 * Bundler Detector — detect an ACTIVE insider transfer-burst pattern.
 *
 * KEY INSIGHT: not all bundler activity is bad.
 *  - Normal launch: creator distributes tokens to many wallets at launch (GOOD).
 *  - Rug pattern: a bundler gathers tokens AFTER people have bought (BAD).
 *
 * Detection logic:
 *  1. Fetch recent transfers for the token via the Helius Enhanced
 *     Transactions API (last 50 txs).
 *  2. Focus on VERY recent activity (last 30s = "active now").
 *  3. Only flag as bundler if the pattern is happening NOW, not historically.
 *  4. Persist detections to `data/bundler-history.json` for wallet-blacklist
 *     learning and future pagination analysis.
 *
 * Requires the optional `HELIUS_API_KEY` env var. When it's absent the detector
 * no-ops (returns a neutral, non-bundler result), so bundler checks are simply
 * skipped rather than blocking the trading loop.
 */

const HELIUS_BASE = 'https://api.helius.xyz/v0';

/** Result of a bundler-pattern check for a single token. */
export interface BundlerResult {
  isBundler: boolean;
  hasHistory: boolean;
  details: string;
  /** Transfer count inside the active (last-30s) window. */
  transfers: number;
  /** Unique fee payers inside the active window. */
  uniquePayers: number;
  historyTransfers?: number;
  totalTransfersAvailable?: number;
  burstPosition?: string;
  wouldPaginationHelp?: boolean;
  /** Fee-payer wallets seen in the active window (used for blacklist learning). */
  payerWallets?: string[];
}

interface WalletRecord {
  seenIn: string[];
  bundlerCount: number;
  lastSeen?: string;
  blacklisted?: boolean;
  blacklistedAt?: string;
}

interface TokenDetection {
  timestamp: string;
  isBundler: boolean;
  hasHistory: boolean;
  transfersInBurst: number;
  uniquePayers: number;
  totalTransfersAvailable: number;
  burstPosition: string;
  wouldPaginationHelp: boolean;
  details: string;
  pnl: number;
}

interface TokenRecord {
  symbol: string;
  firstDetected: string;
  lastDetected?: string;
  detections: TokenDetection[];
}

interface BundlerHistory {
  tokens: Record<string, TokenRecord>;
  wallets: Record<string, WalletRecord>;
  stats: Record<string, number | string>;
  paginationAnalysis: Record<string, number>;
}

/** A single Helius Enhanced Transaction (only the fields we use). */
interface HeliusTx {
  type?: string;
  timestamp?: number;
  feePayer?: string;
  description?: string;
}

const HISTORY_FILE = path.join(process.cwd(), 'data', 'bundler-history.json');

// Cache results to avoid re-checking the same token repeatedly.
const checkCache = new Map<string, { ts: number; result: BundlerResult }>();
const CACHE_TTL = 15_000; // 15 seconds

// ─── History Management ─────────────────────────────────────────────────────
function loadHistory(): BundlerHistory {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as BundlerHistory;
  } catch {
    return { tokens: {}, wallets: {}, stats: {}, paginationAnalysis: {} };
  }
}

function saveHistory(history: BundlerHistory): void {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    logger.error('BundlerDetector: save history failed', { err: String(e) });
  }
}

/**
 * Persist a detection result. Always records the token detection (even when not
 * a bundler) for learning; only counts fee-payer wallets toward the blacklist
 * when the result is an actual bundler. Auto-blacklists a wallet after 5
 * bundler detections.
 */
export function saveBundlerDetection(
  tokenMint: string,
  symbol: string,
  result: BundlerResult,
  pnl = 0,
): void {
  const history = loadHistory();
  const now = new Date().toISOString();

  // ── Token detection ──
  if (!history.tokens[tokenMint]) {
    history.tokens[tokenMint] = { symbol, firstDetected: now, detections: [] };
  }
  const token = history.tokens[tokenMint];
  token.lastDetected = now;
  token.symbol = symbol;
  token.detections.push({
    timestamp: now,
    isBundler: result.isBundler,
    hasHistory: result.hasHistory,
    transfersInBurst: result.transfers,
    uniquePayers: result.uniquePayers,
    totalTransfersAvailable: result.totalTransfersAvailable ?? 50,
    burstPosition: result.burstPosition ?? 'unknown',
    wouldPaginationHelp: result.wouldPaginationHelp ?? false,
    details: result.details,
    pnl,
  });
  // Keep only the last 20 detections per token.
  if (token.detections.length > 20) {
    token.detections = token.detections.slice(-20);
  }

  // ── Wallet blacklist learning (only on actual bundler detections) ──
  if (result.isBundler && result.payerWallets && result.payerWallets.length > 0) {
    for (const wallet of result.payerWallets) {
      if (!wallet) continue;
      if (!history.wallets[wallet]) {
        history.wallets[wallet] = { seenIn: [], bundlerCount: 0 };
      }
      const w = history.wallets[wallet];
      if (!w.seenIn.includes(tokenMint)) w.seenIn.push(tokenMint);
      w.bundlerCount++;
      w.lastSeen = now;
      // Auto-blacklist after >=5 bundler detections (strict, to avoid a
      // false-positive cascade).
      if (w.bundlerCount >= 5) {
        w.blacklisted = true;
        w.blacklistedAt = now;
      }
    }
  }

  // ── Global stats ──
  history.stats.totalDetections = (Number(history.stats.totalDetections) || 0) + 1;
  history.stats.totalBundler = (Number(history.stats.totalBundler) || 0) + (result.isBundler ? 1 : 0);
  history.stats.totalHistorical = (Number(history.stats.totalHistorical) || 0) + (result.hasHistory ? 1 : 0);
  history.stats.totalPnl = (Number(history.stats.totalPnl) || 0) + pnl;
  history.stats.lastUpdated = now;

  // ── Pagination analysis data ──
  if (result.burstPosition) {
    const pos = result.burstPosition;
    history.paginationAnalysis[pos] = (history.paginationAnalysis[pos] || 0) + 1;
    history.paginationAnalysis.total = (history.paginationAnalysis.total || 0) + 1;
  }

  saveHistory(history);
}

/** True if a fee-payer wallet has been auto-blacklisted. */
export function isBlacklistedWallet(wallet: string): boolean {
  const history = loadHistory();
  return history.wallets[wallet]?.blacklisted === true;
}

/** True if the token's most recent recorded detection flagged it as a bundler. */
export function isKnownBundlerToken(tokenMint: string): boolean {
  const tokenData = loadHistory().tokens[tokenMint];
  if (!tokenData) return false;
  const last = tokenData.detections[tokenData.detections.length - 1];
  return last?.isBundler === true;
}

const NEUTRAL = (details: string): BundlerResult => ({
  isBundler: false,
  hasHistory: false,
  details,
  transfers: 0,
  uniquePayers: 0,
});

// ─── Main Detection ─────────────────────────────────────────────────────────
export async function checkBundlerPattern(
  tokenMint: string,
  symbol = 'Unknown',
): Promise<BundlerResult> {
  const apiKey = ENV.heliusApiKey;
  if (!apiKey) return NEUTRAL('Helius API key not configured');

  const cached = checkCache.get(tokenMint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  try {
    const url = `${HELIUS_BASE}/addresses/${tokenMint}/transactions?api-key=${apiKey}&limit=50`;
    const resp = await axios.get<HeliusTx[]>(url, { timeout: 10_000 });
    const txs = resp.data;
    if (!Array.isArray(txs) || txs.length === 0) {
      return NEUTRAL('No transactions');
    }

    // Transfers only.
    const transfers = txs.filter((tx) => tx.type === 'TRANSFER');
    if (transfers.length === 0) return NEUTRAL('No transfers');

    const now = Math.floor(Date.now() / 1000);

    let isBundler = false;
    const reasons: string[] = [];
    let burstPosition = 'first_50';
    let wouldPaginationHelp = false;

    // ── Smart 50-tx detection (no pagination needed) ──
    if (transfers.length === 50) {
      const oldest = transfers[transfers.length - 1].timestamp ?? 0;
      const newest = transfers[0].timestamp ?? 0;
      const spanSeconds = newest - oldest;
      if (spanSeconds < 60) {
        isBundler = true;
        reasons.push(`50 transactions in ${spanSeconds} seconds`);
        burstPosition = 'first_50';
        wouldPaginationHelp = false;
      }
    }

    // ── ACTIVE window: last 30 seconds ──
    const activeWindow = 30;
    const activeTransfers = transfers.filter((tx) => now - (tx.timestamp ?? 0) < activeWindow);

    // ── HISTORICAL window: 30s to 10min ago ──
    const historyTransfers = transfers.filter((tx) => {
      const age = now - (tx.timestamp ?? 0);
      return age >= activeWindow && age < 600;
    });

    // ── Analyse ACTIVE transfers ──
    const payerWallets: string[] = [];

    if (activeTransfers.length > 0) {
      const activePayers = new Set<string>();
      for (const tx of activeTransfers) {
        const payer = tx.feePayer ?? '';
        activePayers.add(payer);
        if (!payerWallets.includes(payer)) payerWallets.push(payer);
      }

      // Rule 1: many transfers from very few payers.
      if (activeTransfers.length >= 20 && activePayers.size <= 2) {
        reasons.push(`${activeTransfers.length} transfers from ${activePayers.size} payers in ${activeWindow}s`);
        isBundler = true;
      }

      // Rule 2: burst within 5s — only if very few payers (real bundler is
      // 1-2 wallets doing many transfers).
      const timestamps = activeTransfers.map((tx) => tx.timestamp ?? 0).sort((a, b) => a - b);
      let burstCount = 0;
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] - timestamps[i - 1] < 5) burstCount++;
      }
      if (burstCount >= 15 && activePayers.size <= 3) {
        reasons.push(`${burstCount} transfers within 5 seconds from ${activePayers.size} payers`);
        isBundler = true;
      }

      // Burst position for pagination analysis.
      if (isBundler) {
        if (activeTransfers.length >= 50) {
          burstPosition = 'first_50';
          wouldPaginationHelp = false;
        } else if (transfers.length === 50) {
          const oldestTx = transfers[transfers.length - 1].timestamp ?? 0;
          if (now - oldestTx < 120) {
            burstPosition = 'possibly_beyond_50';
            wouldPaginationHelp = true;
          }
        }
      }
    }

    // ── Analyse HISTORICAL transfers ──
    let hasHistory = false;
    if (historyTransfers.length > 0) {
      const historyPayers = new Set<string>();
      for (const tx of historyTransfers) historyPayers.add(tx.feePayer ?? '');
      if (historyTransfers.length >= 10 && historyPayers.size <= 3) hasHistory = true;
    }

    // Blacklist trigger — only if there's already some active-transfer evidence
    // (avoids a false-positive cascade on a lone transfer).
    const blacklistedPayers = payerWallets.filter((w) => isBlacklistedWallet(w));
    if (blacklistedPayers.length > 0 && activeTransfers.length >= 5) {
      isBundler = true;
      reasons.push(`Blacklisted wallet: ${blacklistedPayers[0].slice(0, 12)}...`);
    }

    const result: BundlerResult = {
      isBundler,
      hasHistory,
      details: isBundler
        ? `ACTIVE: ${reasons.join('; ')}`
        : hasHistory
          ? 'Historical bundler (normal launch)'
          : 'Normal',
      transfers: activeTransfers.length,
      uniquePayers: activeTransfers.length > 0
        ? new Set(activeTransfers.map((tx) => tx.feePayer ?? '')).size
        : 0,
      historyTransfers: historyTransfers.length,
      totalTransfersAvailable: transfers.length,
      burstPosition,
      wouldPaginationHelp,
      payerWallets,
    };

    checkCache.set(tokenMint, { ts: Date.now(), result });
    return result;
  } catch (e: any) {
    logger.warn('BundlerDetector: check failed', { token: tokenMint, symbol, err: e?.message ?? String(e) });
    return NEUTRAL('Error: ' + (e?.message ?? String(e)));
  }
}

/** Clear the cached result for a token (forces a fresh check). */
export function clearBundlerCache(tokenMint: string): void {
  checkCache.delete(tokenMint);
}
