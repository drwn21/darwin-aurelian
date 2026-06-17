import { TokenInfo } from '../types/index.js';

const STOP_WORDS = new Set(['the', 'coin', 'token', 'sol', 'pump', 'inu', 'meme', '2', '2.0']);

/**
 * Derive a cohort grouping key from a token's symbol and name.
 * Normalises to lowercase, strips stop words, and returns the longest
 * remaining word so that "PEPE coin" and "PepeToken" map to the same key.
 * Falls back to the token address when no meaningful word remains.
 */
export function themeKey(token: TokenInfo): string {
  const combined = `${token.symbol} ${token.name}`
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ');
  const words = combined.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => !STOP_WORDS.has(w));
  if (filtered.length === 0) return token.address;
  return filtered.reduce((a, b) => (a.length >= b.length ? a : b));
}
