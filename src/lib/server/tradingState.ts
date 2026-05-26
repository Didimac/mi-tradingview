/**
 * Server-side paper trading state — persisted in Vercel Blob.
 *
 * Single JSON file "trading-state.json" holds all state:
 *   - capital, position, history
 *   - autoMode toggle
 *   - lastSignalTimes (cooldown tracking)
 */

import { put, list } from "@vercel/blob";

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
  position: ServerPosition | null;
  history: ServerTrade[];
  autoMode: boolean;
  lastSignalTimes: Record<string, number>;  // symbol → timestamp ms
  lastScanTime: number;                      // last cron run ms
  lastScanResults: ScanResult[];             // latest scores for UI
}

export interface ScanResult {
  symbol: string;
  score: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  regime: "BULL" | "BEAR";
  components: { fundingRate: number; rsiDivergence: number; vwapWeekly: number };
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionUSDT: number;
  reason: string;
}

// ─── Constants ───

const BLOB_KEY = "trading-state.json";
const START_CAPITAL = 1000;

function defaultState(): TradingState {
  return {
    capital: START_CAPITAL,
    startCapital: START_CAPITAL,
    position: null,
    history: [],
    autoMode: false,
    lastSignalTimes: {},
    lastScanTime: 0,
    lastScanResults: [],
  };
}

// ─── Blob operations ───

/**
 * Use list() to get the blob's downloadUrl — this includes an auth token
 * that bypasses CDN caching and always returns fresh content.
 * The public `.url` is aggressively cached by CDN and returns stale data.
 */
async function findBlobDownloadUrl(): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY });
    if (blobs.length > 0) return blobs[0].downloadUrl;
    return null;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<TradingState> {
  try {
    const downloadUrl = await findBlobDownloadUrl();
    if (!downloadUrl) return defaultState();

    const res = await fetch(downloadUrl, { cache: "no-store" });
    if (!res.ok) return defaultState();

    const data = await res.json();
    // Merge with defaults to handle missing fields from older versions
    return { ...defaultState(), ...data };
  } catch (e) {
    console.error("[TradingState] Failed to load:", e);
    return defaultState();
  }
}

export async function saveState(state: TradingState): Promise<void> {
  try {
    await put(BLOB_KEY, JSON.stringify(state), {
      access: "public",
      addRandomSuffix: false,
    });
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
  if (state.position) return { opened: false, state };

  const riskAmt = state.capital * 0.015; // 1.5% risk
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

  return {
    opened: true,
    state: { ...state, position: pos },
  };
}

/**
 * Check current price against open position SL/TP.
 * Uses candle high/low for more accurate detection in 15-min intervals.
 */
export function checkPriceAction(
  state: TradingState,
  high: number,
  low: number,
  close: number,
): { event: "none" | "tp1_partial" | "tp2_close" | "sl_close"; state: TradingState; pnl?: number; pnlPct?: number } {
  const pos = state.position;
  if (!pos) return { event: "none", state };

  if (pos.side === "long") {
    // SL check
    if (low <= pos.sl) {
      return closeFull(state, pos.sl, "Stop Loss");
    }
    // TP1 partial
    if (!pos.partialClosed && high >= pos.tp1) {
      return partialClose(state);
    }
    // TP2 full
    if (pos.partialClosed && high >= pos.tp2) {
      return closeFull(state, pos.tp2, "Take Profit 2");
    }
  } else {
    // SHORT
    if (high >= pos.sl) {
      return closeFull(state, pos.sl, "Stop Loss");
    }
    if (!pos.partialClosed && low <= pos.tp1) {
      return partialClose(state);
    }
    if (pos.partialClosed && low <= pos.tp2) {
      return closeFull(state, pos.tp2, "Take Profit 2");
    }
  }

  return { event: "none", state };
}

function partialClose(state: TradingState): { event: "tp1_partial"; state: TradingState; pnl: number; pnlPct: number } {
  const pos = state.position!;
  const closedQty = pos.originalQty * 0.5;
  const pnlPerUnit = pos.side === "long"
    ? pos.tp1 - pos.entryPrice
    : pos.entryPrice - pos.tp1;
  const pnl = pnlPerUnit * closedQty;
  const pnlPct = (pnl / state.capital) * 100;

  return {
    event: "tp1_partial",
    pnl,
    pnlPct,
    state: {
      ...state,
      capital: state.capital + pnl,
      position: {
        ...pos,
        qty: pos.qty - closedQty,
        sl: pos.entryPrice, // SL → breakeven
        partialClosed: true,
      },
    },
  };
}

function closeFull(
  state: TradingState,
  exitPrice: number,
  exitReason: string,
): { event: "tp2_close" | "sl_close"; state: TradingState; pnl: number; pnlPct: number } {
  const pos = state.position!;
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

  return {
    event: exitReason.includes("Profit") ? "tp2_close" : "sl_close",
    pnl,
    pnlPct,
    state: {
      ...state,
      capital: state.capital + pnl,
      position: null,
      history: [...state.history, trade],
    },
  };
}
