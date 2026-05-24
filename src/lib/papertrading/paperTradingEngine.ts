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
  tp: number;
  entryTime: number;
  reason: string;
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

interface PaperTradingState {
  capital: number;
  startCapital: number;
  position: PaperPosition | null;
  history: PaperTrade[];
  toasts: Toast[];
  riskPerTrade: number;

  // Actions
  openTrade: (params: {
    symbol: string;
    side: "long" | "short";
    price: number;
    sl: number;
    tp: number;
    reason: string;
  }) => void;
  closeTrade: (exitPrice: number, exitReason: string) => void;
  checkPrice: (symbol: string, price: number) => void;
  addToast: (type: ToastType, message: string) => void;
  dismissToast: (id: string) => void;
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

      openTrade: ({ symbol, side, price, sl, tp, reason }) => {
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
          entryTime: Date.now(),
          reason,
        };

        set({ position: pos });
        get().addToast(
          "signal",
          `${side.toUpperCase()} ${symbol} @ ${price.toFixed(2)} | SL ${sl.toFixed(2)} | TP ${tp.toFixed(2)}`,
        );
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
      },

      checkPrice: (symbol, price) => {
        const state = get();
        const pos = state.position;
        if (!pos || pos.symbol !== symbol) return;

        if (pos.side === "long") {
          if (price <= pos.sl) {
            get().closeTrade(pos.sl, "Stop Loss");
          } else if (price >= pos.tp) {
            get().closeTrade(pos.tp, "Take Profit");
          }
        } else {
          if (price >= pos.sl) {
            get().closeTrade(pos.sl, "Stop Loss");
          } else if (price <= pos.tp) {
            get().closeTrade(pos.tp, "Take Profit");
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
      }),
    },
  ),
);

// -----------------------------------------------------------------
// WebSocket price monitor — call once from a top-level component
// -----------------------------------------------------------------

let monitorUnsub: (() => void) | null = null;

export function startPriceMonitor() {
  if (monitorUnsub) return;
  const ws = getBinanceWS();

  const symbols = ["LINKUSDT", "SOLUSDT"];
  monitorUnsub = ws.subscribeMiniTickers(symbols, (tick) => {
    usePaperTrading.getState().checkPrice(tick.symbol, tick.close);
  });
}

export function stopPriceMonitor() {
  monitorUnsub?.();
  monitorUnsub = null;
}
