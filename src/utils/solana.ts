import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Commitment,
  BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { ENV } from '../config/config.js';
import { logger } from '../logger/Logger.js';
import { TX_CONFIRM_TIMEOUT_MS, DEFAULT_PRIORITY_FEE_LAMPORTS } from '../config/constants.js';

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(ENV.rpcEndpoint, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: TX_CONFIRM_TIMEOUT_MS,
    });
  }
  return _connection;
}

/**
 * Build a Keypair from a base58-encoded private key. Accepts both the 64-byte
 * secret key and the 32-byte seed encodings. Throws a clear error on bad input.
 */
export function keypairFromBase58(privateKey: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(privateKey.trim());
  } catch {
    throw new Error('PRIVATE_KEY is not valid base58');
  }
  if (decoded.length === 64) {
    return Keypair.fromSecretKey(decoded);
  }
  if (decoded.length === 32) {
    return Keypair.fromSeed(decoded);
  }
  throw new Error(`PRIVATE_KEY must decode to 32 or 64 bytes, got ${decoded.length}`);
}

/** The bot's wallet, lazily decoded from ENV.privateKey and cached. */
export function getWallet(): Keypair {
  if (!_wallet) {
    _wallet = keypairFromBase58(ENV.privateKey);
    logger.info('Wallet loaded', { pubkey: _wallet.publicKey.toBase58() });
  }
  return _wallet;
}

/** Wallet SOL balance (in SOL, not lamports). */
export async function getWalletBalanceSol(): Promise<number> {
  const lamports = await getConnection().getBalance(getWallet().publicKey, 'confirmed');
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Raw token balance (in base units) for `tokenMint` held by the wallet.
 * Sums all token accounts for the mint; returns 0 if none / on error.
 */
export async function getTokenBalance(
  tokenMint: string,
  owner?: PublicKey,
): Promise<number> {
  const conn = getConnection();
  const ownerKey = owner ?? getWallet().publicKey;
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(ownerKey, {
      mint: new PublicKey(tokenMint),
    });
    let total = 0;
    for (const { account } of accounts.value) {
      const amount = account.data.parsed?.info?.tokenAmount?.amount;
      total += Number(amount ?? 0);
    }
    return Number.isFinite(total) ? total : 0;
  } catch (err) {
    logger.warn('getTokenBalance failed', { tokenMint, err: String(err) });
    return 0;
  }
}

/** UI (decimal-adjusted) token balance for `tokenMint`. */
export async function getTokenBalanceUi(tokenMint: string): Promise<number> {
  const conn = getConnection();
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(getWallet().publicKey, {
      mint: new PublicKey(tokenMint),
    });
    let total = 0;
    for (const { account } of accounts.value) {
      total += Number(account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    }
    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}

/**
 * Poll signature status until the tx reaches `commitment` (or finalized), or
 * the timeout elapses. Returns true only if confirmed without an on-chain error.
 */
export async function confirmTransaction(
  txSig: string,
  commitment: Commitment = 'confirmed',
  timeoutMs: number = TX_CONFIRM_TIMEOUT_MS,
): Promise<boolean> {
  const conn = getConnection();
  const start = Date.now();
  const ranks: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };
  const target = ranks[commitment] ?? 1;

  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatus(txSig, { searchTransactionHistory: false });
    if (value) {
      if (value.err) {
        logger.warn('Transaction confirmed with error', { txSig, err: JSON.stringify(value.err) });
        return false;
      }
      const reached = ranks[value.confirmationStatus ?? 'processed'] ?? 0;
      if (reached >= target) return true;
    }
    await sleep(1_500);
  }

  logger.warn('Transaction confirmation timed out', { txSig, timeoutMs });
  return false;
}

export async function getLatestBlockhash(
  commitment: Commitment = 'confirmed',
): Promise<BlockhashWithExpiryBlockHeight> {
  return getConnection().getLatestBlockhash(commitment);
}

export function deserializeVersionedTransaction(buf: Buffer): VersionedTransaction {
  return VersionedTransaction.deserialize(buf);
}

/**
 * Sign, send, and confirm a versioned transaction. Resends a few times on
 * transient send failures, then waits for confirmation. Throws if the tx is
 * never confirmed.
 */
export async function sendAndConfirmVersionedTx(
  tx: VersionedTransaction,
  commitment: Commitment = 'confirmed',
): Promise<string> {
  const conn = getConnection();
  tx.sign([getWallet()]);
  const raw = tx.serialize();

  let sig = '';
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      sig = await conn.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: commitment,
        maxRetries: 3,
      });
      break;
    } catch (err) {
      lastErr = err;
      logger.debug('sendRawTransaction retry', { attempt, err: String(err) });
      await sleep(500 * attempt);
    }
  }
  if (!sig) throw new Error(`Failed to send transaction: ${String(lastErr)}`);

  const confirmed = await confirmTransaction(sig, commitment);
  if (!confirmed) throw new Error(`Transaction not confirmed: ${sig}`);
  return sig;
}

/**
 * Estimate a priority fee (in total lamports) from recent network activity.
 *
 * Queries getRecentPrioritizationFees, takes the given percentile of the
 * non-zero micro-lamport/CU samples, multiplies by the compute-unit budget,
 * and clamps the result between a floor (DEFAULT_PRIORITY_FEE_LAMPORTS) and a
 * sane ceiling. Falls back to the floor if the RPC returns no data.
 *
 * @param computeUnits  CU budget the fee will be spread across (default 200k).
 * @param writableAccounts  Hot accounts to scope the fee samples to.
 * @param percentile  0–1 percentile of recent fees to target (default 0.75).
 */
export async function estimatePriorityFeeLamports(
  computeUnits = 200_000,
  writableAccounts: PublicKey[] = [],
  percentile = 0.75,
  maxLamports = 5_000_000,
): Promise<number> {
  const conn = getConnection();
  try {
    const fees = await conn.getRecentPrioritizationFees(
      writableAccounts.length ? { lockedWritableAccounts: writableAccounts } : undefined,
    );

    const samples = fees
      .map((f) => f.prioritizationFee)
      .filter((v) => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b);

    if (samples.length === 0) return DEFAULT_PRIORITY_FEE_LAMPORTS;

    const idx = Math.min(samples.length - 1, Math.floor(percentile * (samples.length - 1)));
    const microLamportsPerCu = samples[idx] ?? 0;

    // micro-lamports/CU × CU ÷ 1e6 = lamports.
    const estimated = Math.ceil((microLamportsPerCu * computeUnits) / 1_000_000);

    return Math.min(maxLamports, Math.max(DEFAULT_PRIORITY_FEE_LAMPORTS, estimated));
  } catch (err) {
    logger.warn('estimatePriorityFeeLamports failed, using default', { err: String(err) });
    return DEFAULT_PRIORITY_FEE_LAMPORTS;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Authorities decoded straight from an SPL Token Mint account. `null` = revoked. */
export interface MintAuthorityInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

/**
 * Read the SPL Token Mint account directly from chain and decode its mint /
 * freeze authorities — the source of truth for whether a token can still be
 * minted into oblivion or have balances frozen. GMGN's renounce flags are
 * frequently stale (always 0) for fresh Pump.fun tokens, so callers prefer this.
 *
 * Returns `null` on any RPC / decode failure so callers can fall back to the
 * (less reliable) API metadata rather than blocking outright.
 *
 * Mint account layout (packed, little-endian; 82 bytes):
 *   [0..4)    mint_authority COption tag (0 = None/revoked, 1 = Some)
 *   [4..36)   mint_authority pubkey (ignored when tag = 0)
 *   [36..44)  supply (u64)
 *   [44]      decimals
 *   [45]      is_initialized
 *   [46..50)  freeze_authority COption tag
 *   [50..82)  freeze_authority pubkey
 */
export async function checkMintAuthority(
  tokenAddress: string,
): Promise<MintAuthorityInfo | null> {
  try {
    const info = await getConnection().getAccountInfo(new PublicKey(tokenAddress));
    if (!info || info.data.length < 82) {
      logger.warn('checkMintAuthority: mint account missing or undersized', {
        tokenAddress,
        len: info?.data.length ?? 0,
      });
      return null;
    }
    const data = info.data;

    const mintAuthority =
      data.readUInt32LE(0) === 1 ? new PublicKey(data.subarray(4, 36)).toBase58() : null;
    const freezeAuthority =
      data.readUInt32LE(46) === 1 ? new PublicKey(data.subarray(50, 82)).toBase58() : null;

    return { mintAuthority, freezeAuthority };
  } catch (err) {
    logger.warn('checkMintAuthority failed', { tokenAddress, err: String(err) });
    return null;
  }
}
