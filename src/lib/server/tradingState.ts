/**
 * Server-side paper trading state — persisted in Vercel Blob.
 *
 * Single JSON file "trading-state.json" holds all state:
 *   - capital, position, history
 *   - autoMode toggle
 *   - lastSignalTimes (cooldown tracking)
 *
 * Persistence strategy (atomic write-then-cleanup):
 *   1. put() new blob with random suffix → always succeeds, new URL
 *   2. del() old blobs → cleanup stale entries
 *   This avoids the race condition where del-then-put leaves a gap
 *   with no blob, causing concurrent readers to get defaultState().
 */

import { put, list, del } from "@vercel/blob";

// ─── Types ───

export interface ServerPosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  sl: number;
  tp1: number;
  tp2: number;
  entryTime: number;
  reason: string;
  partialClosed: boolean;
  originalQty: number;
}

export interface ServerTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  entryTime: number;
  exitTime: number;
  reason: string;
  exitReason: string;
}

export interface TradingState {
  capital: number;
  startCapital: number;
  /** @deprecated Use positions[] — kept for backward compat on load */
  position: ServerPosition | null;
  positions: ServerPosition[];
  history: ServerTrade[];
  autoMode: boolean;
  lastSignalTimes: Record<string, number>;  // symbol → timestamp ms
  lastScanTime: number;                      // last cron run ms
  lastScanResults: ScanResult[];             // latest scores for UI
}

const MAX_POSITIONS = 3;

export interface ScanResult {
  symbol: string;
  timeframe?: string;
  score: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  regime: "BULL" | "BEAR";
  components: { fundingRate: number; rsiDivergence: number; vwapWeekly: number; ssl?: number };
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionUSDT: number;
  reason: string;
}

// ─── Constants ───

const BLOB_KEY = "trading-state.json";
/** Prefix for list() — must match blobs created with addRandomSuffix:true
 *  e.g. "trading-state-AbCdEf.json" starts with "trading-state" */
const BLOB_PREFIX = "trading-state";
const START_CAPITAL = 1000;

function defaultState(): TradingState {
  return {
    capital: START_CAPITAL,
    startCapital: START_CAPITAL,
    position: null,
    positions: [],
    history: [],
    autoMode: false,
    lastSignalTimes: {},
    lastScanTime: 0,
    lastScanResults: [],
  };
}

// ─── Blob operations ───

/**
 * Atomic write-then-cleanup strategy:
 *   loadState: list all blobs with prefix, pick newest (by uploadedAt)
 *   saveState: put new blob WITH random suffix, then delete old blobs
 *
 * This eliminates the del→put gap that caused state loss during deployments.
 */

export async function loadState(): Promise<TradingState> {
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX });
    if (blobs.length === 0) return defaultState();

    // Pick the newest blob (in case multiple exist during write-then-cleanup)
    const sorted = [...blobs].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );
    const newest = sorted[0];

    const res = await fetch(newest.downloadUrl, { cache: "no-store" });
    if (!res.ok) return defaultState();

    const data = await res.json();

    const loaded = { ...defaultState(), ...data } as TradingState;
    // Migrate old single-position format to positions array
    if (!loaded.positions) loaded.positions = [];
    if (loaded.position && loaded.positions.length === 0) {
      loaded.positions = [loaded.position];
    }
    loaded.position = loaded.positions[0] ?? null;
    return loaded;
  } catch (e) {
    console.error("[TradingState] Failed to load:", e);
    return defaultState();
  }
}

export async function saveState(state: TradingState): Promise<void> {
  try {
    // Keep position in sync with positions array for backward compat
    state.position = state.positions[0] ?? null;
    const newBlob = await put(BLOB_KEY, JSON.stringify(state), {
      access: "public",
      addRandomSuffix: true,       // ensures unique URL, no CDN collision
      cacheControlMaxAge: 60,
    });

    // 2. THEN CLEANUP — delete all old blobs (not the one we just wrote)
    const { blobs } = await list({ prefix: BLOB_PREFIX });
    const oldBlobs = blobs.filter((b) => b.url !== newBlob.url);
    if (oldBlobs.length > 0) {
      await del(oldBlobs.map((b) => b.url));
    }
  } catch (e) {
    console.error("[TradingState] Failed to save:", e);
  }
}

// ─── Helper functions ───

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function openPosition(
  state: TradingState,
  params: {
    symbol: string;
    side: "long" | "short";
    price: number;
    sl: number;
    tp1: number;
    tp2: number;
    reason: string;
  },
): { opened: boolean; state: TradingState } {
  if (state.positions.length >= MAX_POSITIONS) return { opened: false, state };
  if (state.positions.some((p) => p.symbol === params.symbol)) return { opened: false, state };

  const riskAmt = state.capital * 0.015;
  const stopDist = Math.abs(params.price - params.sl);
  if (stopDist === 0) return { opened: false, state };
  const qty = riskAmt / stopDist;

  const pos: ServerPosition = {
    id: genId(),
    symbol: params.symbol,
    side: params.side,
    entryPrice: params.price,
    qty,
    sl: params.sl,
    tp1: params.tp1,
    tp2: params.tp2,
    entryTime: Date.now(),
    reason: params.reason,
    partialClosed: false,
    originalQty: qty,
  };

  const positions = [...state.positions, pos];
  return {
    opened: true,
    state: { ...state, positions, position: positions[0] },
  };
}

export interface PriceActionResult {
  event: "none" | "tp1_partial" | "tp2_close" | "sl_close";
  state: TradingState;
  pnl?: number;
  pnlPct?: number;
  symbol?: string;
}

export function checkPriceAction(
  state: TradingState,
  high: number,
  low: number,
  close: number,
  symbol?: string,
): PriceActionResult {
  const pos = symbol
    ? state.positions.find((p) => p.symbol === symbol)
    : state.positions[0];
  if (!pos) return { event: "none", state };

  if (pos.side === "long") {
    if (low <= pos.sl) {
      return closeFullMulti(state, pos, pos.sl, "Stop Loss");
    }
    if (!pos.partialClosed && high >= pos.tp1) {
      return partialCloseMulti(state, pos);
    }
    if (pos.partialClosed && high >= pos.tp2) {
      return closeFullMulti(state, pos, pos.tp2, "Take Profit 2");
    }
  } else {
    if (high >= pos.sl) {
      return closeFullMulti(state, pos, pos.sl, "Stop Loss");
    }
    if (!pos.partialClosed && low <= pos.tp1) {
      return partialCloseMulti(state, pos);
    }
    if (pos.partialClosed && low <= pos.tp2) {
      return closeFullMulti(state, pos, pos.tp2, "Take Profit 2");
    }
  }

  void close;
  return { event: "none", state };
}

function partialCloseMulti(state: TradingState, pos: ServerPosition): PriceActionResult {
  const closedQty = pos.originalQty * 0.5;
  const pnlPerUnit = pos.side === "long"
    ? pos.tp1 - pos.entryPrice
    : pos.entryPrice - pos.tp1;
  const pnl = pnlPerUnit * closedQty;
  const pnlPct = (pnl / state.capital) * 100;

  const updatedPos: ServerPosition = {
    ...pos,
    qty: pos.qty - closedQty,
    sl: pos.entryPrice,
    partialClosed: true,
  };
  const positions = state.positions.map((p) => p.id === pos.id ? updatedPos : p);

  return {
    event: "tp1_partial",
    pnl,
    pnlPct,
    symbol: pos.symbol,
    state: {
      ...state,
      capital: state.capital + pnl,
      positions,
      position: positions[0] ?? null,
    },
  };
}

function closeFullMulti(
  state: TradingState,
  pos: ServerPosition,
  exitPrice: number,
  exitReason: string,
): PriceActionResult {
  const pnlPerUnit = pos.side === "long"
    ? exitPrice - pos.entryPrice
    : pos.entryPrice - exitPrice;
  const pnl = pnlPerUnit * pos.qty;
  const pnlPct = (pnl / state.capital) * 100;

  const trade: ServerTrade = {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    qty: pos.qty,
    pnl,
    pnlPct,
    entryTime: pos.entryTime,
    exitTime: Date.now(),
    reason: pos.reason,
    exitReason,
  };

  const positions = state.positions.filter((p) => p.id !== pos.id);

  return {
    event: exitReason.includes("Profit") ? "tp2_close" : "sl_close",
    pnl,
    pnlPct,
    symbol: pos.symbol,
    state: {
      ...state,
      capital: state.capital + pnl,
      positions,
      position: positions[0] ?? null,
      history: [...state.history, trade],
    },
  };
}
