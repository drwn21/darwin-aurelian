/**
 * Declarative field registry that drives the Telegram /config panel.
 *
 * Each editable setting is described once here — its config path, label,
 * display formatting, increment presets and bounds — and both rendering and
 * callback handling are derived from it. Field ids are short and stable so they
 * fit inside Telegram's 64-byte callback_data budget.
 */

export type PanelId = 'main' | 'risk' | 'strategy' | 'trailing' | 'screen' | 'gmgn' | 'safety';

export interface PanelMeta {
  id: PanelId;
  title: string;
}

export const PANELS: PanelMeta[] = [
  { id: 'main', title: 'Main' },
  { id: 'risk', title: 'Risk' },
  { id: 'strategy', title: 'Strategy' },
  { id: 'trailing', title: 'Trailing' },
  { id: 'screen', title: 'Screening' },
  { id: 'gmgn', title: 'GMGN' },
  { id: 'safety', title: 'Safety' },
];

export type NumberKind = 'sol' | 'pct' | 'bps' | 'usd' | 'lamports' | 'durmin' | 'int';

export interface NumberField {
  id: string;
  panel: PanelId;
  /** Dot path into RuntimeConfig (the stored value). */
  path: string;
  label: string;
  type: 'number';
  kind: NumberKind;
  /** stored = display * scale (durmin uses 60000 to edit in minutes). */
  scale: number;
  /** Increment presets, in display units. */
  steps: number[];
  /** Bounds in display units. */
  min: number;
  max: number;
}

export interface EnumField {
  id: string;
  panel: PanelId;
  path: string;
  label: string;
  type: 'enum';
  options: string[];
}

export interface BooleanField {
  id: string;
  panel: PanelId;
  path: string;
  label: string;
  type: 'boolean';
}

export type Field = NumberField | EnumField | BooleanField;

function trim(n: number): string {
  // Strip float noise (0.06000000001 → 0.06) without trailing zeros.
  return parseFloat(n.toFixed(6)).toString();
}

function humanUsd(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${trim(v / 1_000_000)}M`;
  if (Math.abs(v) >= 1_000) return `$${trim(v / 1_000)}K`;
  return `$${trim(v)}`;
}

/** Human-readable rendering of a stored numeric value. */
export function formatNumber(field: NumberField, stored: number): string {
  switch (field.kind) {
    case 'sol':
      return `${trim(stored)} SOL`;
    case 'pct':
      return `${stored > 0 ? '+' : ''}${trim(stored)}%`;
    case 'bps':
      return `${stored} bps (${trim(stored / 100)}%)`;
    case 'usd':
      return humanUsd(stored);
    case 'lamports':
      return `${stored.toLocaleString('en-US')} (${trim(stored / 1e9)} SOL)`;
    case 'durmin':
      return `${trim(stored / 60_000)} min`;
    case 'int':
      return `${stored}`;
  }
}

/** Label for an increment/decrement button, in display units. */
export function formatDelta(field: NumberField, deltaDisplay: number): string {
  const sign = deltaDisplay > 0 ? '+' : '';
  const unit =
    field.kind === 'durmin'
      ? 'm'
      : field.kind === 'sol'
        ? ''
        : field.kind === 'usd'
          ? ''
          : '';
  if (field.kind === 'usd') return `${sign}${humanUsd(deltaDisplay).replace('$', '')}`;
  return `${sign}${trim(deltaDisplay)}${unit}`;
}

/**
 * Ordered list of signed deltas (display units) for the edit view:
 * largest negative → smallest negative → smallest positive → largest positive.
 */
export function buttonDeltas(field: NumberField): number[] {
  const desc = [...field.steps].sort((a, b) => b - a); // big → small
  const negatives = desc.map((s) => -s); // -big … -small
  const positives = [...desc].reverse(); // +small … +big
  return [...negatives, ...positives];
}

/** Apply a display-unit delta to a stored value, clamped to bounds, re-scaled. */
export function applyDelta(field: NumberField, stored: number, deltaDisplay: number): number {
  const display = stored / field.scale;
  const next = Math.min(field.max, Math.max(field.min, display + deltaDisplay));
  const rescaled = next * field.scale;
  // Re-round to kill float drift from scaling.
  return parseFloat(rescaled.toFixed(6));
}

const MIN = 60_000;

export const FIELDS: Field[] = [
  // ── Main ────────────────────────────────────────────────────────────────
  { id: 'm_amt', panel: 'strategy', path: 'main.tradeAmountSol', label: 'Trade amount', type: 'number', kind: 'sol', scale: 1, steps: [0.01, 0.05, 0.1], min: 0.001, max: 10 },
  { id: 'm_max', panel: 'strategy', path: 'main.maxConcurrentPositions', label: 'Max positions', type: 'number', kind: 'int', scale: 1, steps: [1], min: 1, max: 20 },

  // ── Risk ────────────────────────────────────────────────────────────────
  { id: 'r_dll', panel: 'risk', path: 'risk.dailyLossLimitSol', label: 'Daily loss limit', type: 'number', kind: 'sol', scale: 1, steps: [0.05, 0.1, 0.5], min: 0.01, max: 100 },
  { id: 'r_mcl', panel: 'risk', path: 'risk.maxConsecutiveLosses', label: 'Max consecutive losses', type: 'number', kind: 'int', scale: 1, steps: [1], min: 1, max: 20 },
  { id: 'r_cd', panel: 'risk', path: 'risk.cooldownMs', label: 'Cooldown', type: 'number', kind: 'durmin', scale: MIN, steps: [5, 15, 30], min: 1, max: 720 },
  { id: 'r_ptm', panel: 'risk', path: 'risk.maxPerTradeSol', label: 'Per-trade max', type: 'number', kind: 'sol', scale: 1, steps: [0.1, 0.5, 1], min: 0.001, max: 100 },

  // ── Strategy ──────────────────────────────────────────────────────────────
  { id: 's_bsl', panel: 'strategy', path: 'strategy.buySlippageBps', label: 'Buy slippage', type: 'number', kind: 'bps', scale: 1, steps: [50, 100], min: 10, max: 5000 },
  { id: 's_ssl', panel: 'strategy', path: 'strategy.sellSlippageBps', label: 'Sell slippage', type: 'number', kind: 'bps', scale: 1, steps: [50, 100], min: 10, max: 5000 },
  { id: 's_pf', panel: 'strategy', path: 'strategy.priorityFeeLamports', label: 'Priority fee', type: 'number', kind: 'lamports', scale: 1, steps: [100000, 500000], min: 0, max: 10_000_000 },
  { id: 's_pt', panel: 'strategy', path: 'strategy.positionTimeoutMs', label: 'Position timeout', type: 'number', kind: 'durmin', scale: MIN, steps: [5, 15, 30], min: 1, max: 1440 },
  { id: 's_tp', panel: 'strategy', path: 'strategy.takeProfitPct', label: 'TP %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10, 25], min: 5, max: 500 },
  { id: 's_fts', panel: 'strategy', path: 'strategy.firstTargetSellPct', label: 'TP sell %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10], min: 10, max: 100 },
  { id: 's_trl', panel: 'strategy', path: 'strategy.trailingStopPct', label: 'Trail drop %', type: 'number', kind: 'pct', scale: 1, steps: [1, 5], min: 1, max: 50 },
  { id: 's_sl', panel: 'strategy', path: 'strategy.stopLossPct', label: 'SL %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10], min: -90, max: -1 },
  { id: 's_hsl', panel: 'strategy', path: 'strategy.hardStopLossPct', label: 'Hard SL %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10], min: -90, max: -1 },
  { id: 's_grc', panel: 'strategy', path: 'strategy.slGracePeriodMs', label: 'SL grace min', type: 'number', kind: 'durmin', scale: MIN, steps: [1, 2], min: 0, max: 30 },
  { id: 's_slc', panel: 'strategy', path: 'strategy.slConfirms', label: 'SL confirms', type: 'number', kind: 'int', scale: 1, steps: [1], min: 1, max: 10 },
  { id: 's_csba', panel: 'strategy', path: 'strategy.canSellBackMinAgeMs', label: 'Sell-back min age', type: 'number', kind: 'durmin', scale: MIN, steps: [30, 60, 120], min: 1, max: 240 },
  { id: 's_msr', panel: 'strategy', path: 'strategy.maxSellRetries', label: 'Max sell retries', type: 'number', kind: 'int', scale: 1, steps: [1, 5], min: 1, max: 50 },
  { id: 's_pfct', panel: 'strategy', path: 'strategy.priceFailCloseThreshold', label: 'Price fail close threshold', type: 'number', kind: 'int', scale: 1, steps: [1, 4], min: 1, max: 50 },

  // ── Trailing ─────────────────────────────────────────────────────────────
  { id: 't_en', panel: 'trailing', path: 'strategy.tieredTrailingEnabled', label: 'Tiered trailing', type: 'boolean' },
  { id: 't_base', panel: 'trailing', path: 'strategy.trailingStopPct', label: 'Base trail %', type: 'number', kind: 'pct', scale: 1, steps: [1, 5], min: 1, max: 50 },
  { id: 't_100', panel: 'trailing', path: 'strategy.tieredTrailAt100Pct', label: 'Trail at 100%+', type: 'number', kind: 'pct', scale: 1, steps: [1, 2], min: 1, max: 50 },
  { id: 't_200', panel: 'trailing', path: 'strategy.tieredTrailAt200Pct', label: 'Trail at 200%+', type: 'number', kind: 'pct', scale: 1, steps: [1, 2], min: 1, max: 50 },
  { id: 't_500', panel: 'trailing', path: 'strategy.tieredTrailAt500Pct', label: 'Trail at 500%+', type: 'number', kind: 'pct', scale: 1, steps: [1, 2], min: 1, max: 50 },
  { id: 't_1k', panel: 'trailing', path: 'strategy.tieredTrailAt1000Pct', label: 'Trail at 1000%+', type: 'number', kind: 'pct', scale: 1, steps: [1, 2], min: 1, max: 50 },

  // ── Screening ──────────────────────────────────────────────────────────────
  { id: 'c_mnmc', panel: 'screen', path: 'screening.minMarketCapUsd', label: 'Min mcap', type: 'number', kind: 'usd', scale: 1, steps: [5000, 10000], min: 0, max: 10_000_000 },
  { id: 'c_mxmc', panel: 'screen', path: 'screening.maxMarketCapUsd', label: 'Max mcap', type: 'number', kind: 'usd', scale: 1, steps: [50000, 100000], min: 1000, max: 100_000_000 },
  { id: 'c_liq', panel: 'screen', path: 'screening.minLiquidityUsd', label: 'Min liquidity', type: 'number', kind: 'usd', scale: 1, steps: [1000, 5000], min: 0, max: 10_000_000 },
  { id: 'c_hold', panel: 'screen', path: 'screening.minHolderCount', label: 'Min holders', type: 'number', kind: 'int', scale: 1, steps: [10, 50], min: 0, max: 100_000 },
  { id: 'c_age', panel: 'screen', path: 'screening.maxAgeMs', label: 'Max age', type: 'number', kind: 'durmin', scale: MIN, steps: [15, 30, 60], min: 1, max: 10080 },
  { id: 'c_scr', panel: 'screen', path: 'screening.minCompositeScore', label: 'Min score', type: 'number', kind: 'int', scale: 1, steps: [5, 10], min: 0, max: 100 },
  { id: 'c_rsk', panel: 'screen', path: 'screening.maxRiskScore', label: 'Max risk score', type: 'number', kind: 'int', scale: 1, steps: [5, 10], min: 0, max: 100 },
  { id: 'c_vol', panel: 'screen', path: 'screening.minVolume24hUsd', label: 'Min 24h volume', type: 'number', kind: 'usd', scale: 1, steps: [1000, 5000], min: 0, max: 10_000_000 },
  { id: 'c_bndr', panel: 'screen', path: 'screening.maxBundlerRate', label: 'Max bundler %', type: 'number', kind: 'pct', scale: 0.01, steps: [5, 10], min: 0, max: 100 },
  { id: 'c_entr', panel: 'screen', path: 'screening.maxEntrapmentRatio', label: 'Max entrapment %', type: 'number', kind: 'pct', scale: 0.01, steps: [5, 10], min: 0, max: 100 },
  { id: 'c_5mn', panel: 'screen', path: 'screening.minPriceChange5mPct', label: 'Min 5m change %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10], min: -100, max: 0 },
  { id: 'c_5mx', panel: 'screen', path: 'screening.maxPriceChange5mPct', label: 'Max 5m change %', type: 'number', kind: 'pct', scale: 1, steps: [10, 25], min: 0, max: 500 },
  { id: 'c_1h', panel: 'screen', path: 'screening.maxPriceChange1hPct', label: 'Max 1h change %', type: 'number', kind: 'pct', scale: 1, steps: [10, 25], min: 0, max: 500 },
  { id: 'c_1mn', panel: 'screen', path: 'screening.minPriceChange1hPct', label: 'Min 1h change %', type: 'number', kind: 'pct', scale: 1, steps: [5, 10], min: -100, max: 0 },
  { id: 'c_1mi', panel: 'screen', path: 'screening.minPriceChange1mPct', label: 'Min 1m change %', type: 'number', kind: 'pct', scale: 1, steps: [1, 5], min: -100, max: 0 },
  { id: 'c_1ma', panel: 'screen', path: 'screening.maxPriceChange1mPct', label: 'Max 1m change %', type: 'number', kind: 'pct', scale: 1, steps: [10, 25], min: 0, max: 500 },
  { id: 'c_sdg', panel: 'screen', path: 'screening.minSmartDegenCount', label: 'Min smart degens', type: 'number', kind: 'int', scale: 1, steps: [1, 2], min: 0, max: 20 },

  // ── GMGN ──────────────────────────────────────────────────────────────────
  { id: 'g_int', panel: 'gmgn', path: 'gmgn.interval', label: 'Interval', type: 'enum', options: ['1m', '5m', '15m', '1h'] },
  { id: 'g_ord', panel: 'gmgn', path: 'gmgn.orderBy', label: 'Order by', type: 'enum', options: ['volume', 'swaps', 'price_change_percent5m', 'holder_count', 'marketcap'] },
  { id: 'g_lim', panel: 'gmgn', path: 'gmgn.limit', label: 'Limit', type: 'number', kind: 'int', scale: 1, steps: [10, 25], min: 1, max: 100 },
  { id: 'g_vol', panel: 'gmgn', path: 'gmgn.minVolumeUsd', label: 'Min volume', type: 'number', kind: 'usd', scale: 1, steps: [1000, 5000], min: 0, max: 10_000_000 },

  // ── Safety ──────────────────────────────────────────────────────────────────
  { id: 'f_bnd', panel: 'safety', path: 'safety.bundlerCheckEnabled', label: 'Bundler check', type: 'boolean' },
  { id: 'f_rug', panel: 'safety', path: 'safety.rugSignalCheckEnabled', label: 'Rug-signal check', type: 'boolean' },
  { id: 'f_int', panel: 'safety', path: 'safety.bundlerCheckIntervalMs', label: 'Safety check interval', type: 'number', kind: 'durmin', scale: MIN, steps: [0.5, 1], min: 0.1, max: 30 },
  // ── Bundler detector thresholds (runtime tunable) ──
  { id: 'f_r1t', panel: 'safety', path: 'safety.bundler.rule1MinTransfers', label: 'R1 min transfers', type: 'number', kind: 'int', scale: 1, steps: [5, 10], min: 5, max: 100 },
  { id: 'f_r1p', panel: 'safety', path: 'safety.bundler.rule1MaxPayers', label: 'R1 max payers', type: 'number', kind: 'int', scale: 1, steps: [1], min: 1, max: 10 },
  { id: 'f_r2b', panel: 'safety', path: 'safety.bundler.rule2MinBurstCount', label: 'R2 min burst', type: 'number', kind: 'int', scale: 1, steps: [5, 10], min: 5, max: 100 },
  { id: 'f_r2p', panel: 'safety', path: 'safety.bundler.rule2MaxPayers', label: 'R2 max payers', type: 'number', kind: 'int', scale: 1, steps: [1], min: 1, max: 10 },
  { id: 'f_r3b', panel: 'safety', path: 'safety.bundler.rule3MinBurstCount', label: 'R3 extreme burst', type: 'number', kind: 'int', scale: 1, steps: [10, 25], min: 10, max: 200 },
  { id: 'f_dmp', panel: 'safety', path: 'safety.bundler.dumpPriceDropPct', label: 'Dump price drop %', type: 'number', kind: 'int', scale: 1, steps: [1, 5], min: 1, max: 50 },

  // ── Sizing ────────────────────────────────────────────────────────────────
  { id: 'z_adp', panel: 'safety', path: 'sizing.adaptiveSizingEnabled', label: 'Adaptive sizing', type: 'boolean' },
  { id: 'z_tod', panel: 'safety', path: 'sizing.timeAwarenessEnabled', label: 'Time-of-day', type: 'boolean' },
];

const FIELDS_BY_ID = new Map<string, Field>(FIELDS.map((f) => [f.id, f]));

export function fieldById(id: string): Field | undefined {
  return FIELDS_BY_ID.get(id);
}

export function fieldsForPanel(panel: PanelId): Field[] {
  return FIELDS.filter((f) => f.panel === panel);
}

/** Format any field's current value for display on a panel button. */
export function formatField(field: Field, value: unknown): string {
  if (field.type === 'enum') return String(value);
  if (field.type === 'boolean') return value ? 'ON 🟢' : 'OFF ⚪';
  return formatNumber(field, Number(value));
}
