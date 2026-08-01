"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getBinanceWS } from "@/lib/binance/ws";

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export interface PaperPosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  sl: number;
  tp: number;       // TP1 — partial close target
  tp2: number;      // TP2 — full close target
  entryTime: number;
  reason: string;
  /** true after TP1 partial close (50% qty removed, SL moved to breakeven) */
  partialClosed: boolean;
  /** original qty before partial close */
  originalQty: number;
}

export interface PaperTrade {
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

export type ToastType = "signal" | "win" | "loss";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
}

// Callback for trade events (telegram notifications)
type TradeEventCb = (
  event: "open" | "partial_close" | "close",
  data: {
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    exitPrice?: number;
    pnlPct?: number;
    capital?: number;
    exitReason?: string;
    score?: number;
    direction?: string;
    sl?: number;
    tp1?: number;
    tp2?: number;
    positionUSDT?: number;
  },
) => void;

let tradeEventCb: TradeEventCb | null = null;

/** Register a callback for trade events (used by opportunityWatcher for Telegram) */
export function onTradeEvent(cb: TradeEventCb | null) {
  tradeEventCb = cb;
}

/** Trading mode detected from server config */
export type TradingMode = "paper" | "real";

interface PaperTradingState {
  capital: number;
  startCapital: number;
  position: PaperPosition | null;
  history: PaperTrade[];
  toasts: Toast[];
  riskPerTrade: number;
  /** User toggle: auto-execute trades without confirmation */
  autoMode: boolean;
  /** Server-detected mode: paper (no API key) or real (API key configured) */
  tradingMode: TradingMode;

  // Actions
  openTrade: (params: {
    symbol: string;
    side: "long" | "short";
    price: number;
    sl: number;
    tp: number;
    tp2?: number;
    reason: string;
  }) => void;
  closeTrade: (exitPrice: number, exitReason: string) => void;
  checkPrice: (symbol: string, price: number) => void;
  addToast: (type: ToastType, message: string) => void;
  dismissToast: (id: string) => void;
  setAutoMode: (on: boolean) => void;
  setTradingMode: (mode: TradingMode) => void;
  reset: () => void;
}

const START_CAPITAL = 1000;
const RISK_PER_TRADE = 0.015;

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// -----------------------------------------------------------------
// Store
// -----------------------------------------------------------------

export const usePaperTrading = create<PaperTradingState>()(
  persist(
    (set, get) => ({
      capital: START_CAPITAL,
      startCapital: START_CAPITAL,
      position: null,
      history: [],
      toasts: [],
      riskPerTrade: RISK_PER_TRADE,
      autoMode: false,       // default OFF (safer)
      tradingMode: "paper",  // default paper until server check

      setAutoMode: (on) => set({ autoMode: on }),
      setTradingMode: (mode) => set({ tradingMode: mode }),

      openTrade: ({ symbol, side, price, sl, tp, tp2, reason }) => {
        const state = get();
        if (state.position) return;

        const riskAmt = state.capital * state.riskPerTrade;
        const stopDist = Math.abs(price - sl);
        if (stopDist === 0) return;
        const qty = riskAmt / stopDist;

        const pos: PaperPosition = {
          id: genId(),
          symbol,
          side,
          entryPrice: price,
          qty,
          sl,
          tp,
          tp2: tp2 ?? tp,        // fallback to tp if no tp2
          entryTime: Date.now(),
          reason,
          partialClosed: false,
          originalQty: qty,
        };

        set({ position: pos });
        get().addToast(
          "signal",
          `${side.toUpperCase()} ${symbol} @ ${price.toFixed(2)} | SL ${sl.toFixed(2)} | TP1 ${tp.toFixed(2)} | TP2 ${(tp2 ?? tp).toFixed(2)}`,
        );

        // Notify callback
        tradeEventCb?.("open", {
          symbol,
          side,
          entryPrice: price,
          sl,
          tp1: tp,
          tp2: tp2 ?? tp,
          positionUSDT: qty * price,
        });
      },

      closeTrade: (exitPrice, exitReason) => {
        const state = get();
        const pos = state.position;
        if (!pos) return;

        const pnlPerUnit =
          pos.side === "long"
            ? exitPrice - pos.entryPrice
            : pos.entryPrice - exitPrice;
        const pnl = pnlPerUnit * pos.qty;
        const pnlPct = (pnl / state.capital) * 100;
        const newCapital = state.capital + pnl;

        const trade: PaperTrade = {
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

        set({
          position: null,
          capital: newCapital,
          history: [...state.history, trade],
        });

        const sign = pnl >= 0 ? "+" : "";
        get().addToast(
          pnl >= 0 ? "win" : "loss",
          `${exitReason} ${pos.symbol} | ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`,
        );

        // Notify callback
        tradeEventCb?.("close", {
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice,
          pnlPct,
          capital: newCapital,
          exitReason,
        });
      },

      checkPrice: (symbol, price) => {
        const state = get();
        const pos = state.position;
        if (!pos || pos.symbol !== symbol) return;

        if (pos.side === "long") {
          // Check SL
          if (price <= pos.sl) {
            get().closeTrade(pos.sl, "Stop Loss");
            return;
          }
          // Check TP1 partial close (if not already done)
          if (!pos.partialClosed && price >= pos.tp) {
            // Partial close 50% at TP1, move SL to breakeven
            const closedQty = pos.originalQty * 0.5;
            const pnlPerUnit = pos.tp - pos.entryPrice;
            const partialPnl = pnlPerUnit * closedQty;
            const newCapital = state.capital + partialPnl;
            const remainingQty = pos.qty - closedQty;

            set({
              capital: newCapital,
              position: {
                ...pos,
                qty: remainingQty,
                sl: pos.entryPrice,     // SL → breakeven
                partialClosed: true,
              },
            });

            const pnlPct = (partialPnl / state.capital) * 100;
            get().addToast("win", `TP1 parcial ${pos.symbol} | +$${partialPnl.toFixed(2)} (+${pnlPct.toFixed(1)}%) | SL → BE`);

            tradeEventCb?.("partial_close", {
              symbol: pos.symbol,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice: pos.tp,
              pnlPct,
              capital: newCapital,
              exitReason: "TP1 Parcial (50%)",
            });
            return;
          }
          // Check TP2 full close
          if (pos.partialClosed && price >= pos.tp2) {
            get().closeTrade(pos.tp2, "Take Profit 2");
            return;
          }
        } else {
          // SHORT
          if (price >= pos.sl) {
            get().closeTrade(pos.sl, "Stop Loss");
            return;
          }
          if (!pos.partialClosed && price <= pos.tp) {
            const closedQty = pos.originalQty * 0.5;
            const pnlPerUnit = pos.entryPrice - pos.tp;
            const partialPnl = pnlPerUnit * closedQty;
            const newCapital = state.capital + partialPnl;
            const remainingQty = pos.qty - closedQty;

            set({
              capital: newCapital,
              position: {
                ...pos,
                qty: remainingQty,
                sl: pos.entryPrice,
                partialClosed: true,
              },
            });

            const pnlPct = (partialPnl / state.capital) * 100;
            get().addToast("win", `TP1 parcial ${pos.symbol} | +$${partialPnl.toFixed(2)} (+${pnlPct.toFixed(1)}%) | SL → BE`);

            tradeEventCb?.("partial_close", {
              symbol: pos.symbol,
              side: pos.side,
              entryPrice: pos.entryPrice,
              exitPrice: pos.tp,
              pnlPct,
              capital: newCapital,
              exitReason: "TP1 Parcial (50%)",
            });
            return;
          }
          if (pos.partialClosed && price <= pos.tp2) {
            get().closeTrade(pos.tp2, "Take Profit 2");
            return;
          }
        }
      },

      addToast: (type, message) => {
        const toast: Toast = { id: genId(), type, message, createdAt: Date.now() };
        set((s) => ({ toasts: [...s.toasts, toast] }));
        setTimeout(() => {
          get().dismissToast(toast.id);
        }, 5000);
      },

      dismissToast: (id) => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },

      reset: () => {
        set({
          capital: START_CAPITAL,
          startCapital: START_CAPITAL,
          position: null,
          history: [],
        });
      },
    }),
    {
      name: "paper-trading-state",
      partialize: (s) => ({
        capital: s.capital,
        startCapital: s.startCapital,
        position: s.position,
        history: s.history,
        riskPerTrade: s.riskPerTrade,
        autoMode: s.autoMode,
      }),
    },
  ),
);

// -----------------------------------------------------------------
// Standalone API (callable outside React components)
// -----------------------------------------------------------------

/** Check if a paper position is currently open */
export function hasOpenPosition(): boolean {
  return usePaperTrading.getState().position !== null;
}

/** Check if auto mode is enabled AND we're in paper mode */
export function isAutoModeActive(): boolean {
  const s = usePaperTrading.getState();
  // Real money mode → NEVER auto-execute, regardless of toggle
  if (s.tradingMode === "real") return false;
  return s.autoMode;
}

/** Get current paper position */
export function getOpenPosition(): PaperPosition | null {
  return usePaperTrading.getState().position;
}

/** Open a paper trade from outside React (e.g., from opportunityWatcher) */
export function autoOpenTrade(params: {
  symbol: string;
  side: "long" | "short";
  price: number;
  sl: number;
  tp: number;
  tp2: number;
  reason: string;
}): boolean {
  const state = usePaperTrading.getState();
  if (state.position) return false;  // max 1 position
  state.openTrade(params);
  return true;
}

// -----------------------------------------------------------------
// WebSocket price monitor — call once from a top-level component
// -----------------------------------------------------------------

const MONITORED_PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
let monitorUnsub: (() => void) | null = null;

export function startPriceMonitor() {
  if (monitorUnsub) return;
  const ws = getBinanceWS();

  monitorUnsub = ws.subscribeMiniTickers(MONITORED_PAIRS, (tick) => {
    usePaperTrading.getState().checkPrice(tick.symbol, tick.close);
  });
}

export function stopPriceMonitor() {
  monitorUnsub?.();
  monitorUnsub = null;
}
