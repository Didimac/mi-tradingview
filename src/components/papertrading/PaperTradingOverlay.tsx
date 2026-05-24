"use client";

import { useEffect } from "react";
import {
  usePaperTrading,
  startPriceMonitor,
} from "@/lib/papertrading/paperTradingEngine";
import { useChartStore } from "@/lib/store/chart-store";
import { formatPrice, formatPct } from "@/lib/format";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  RotateCcw,
  CircleDot,
} from "lucide-react";

export function PaperTradingOverlay({ livePrice }: { livePrice: number | null }) {
  const capital = usePaperTrading((s) => s.capital);
  const startCapital = usePaperTrading((s) => s.startCapital);
  const position = usePaperTrading((s) => s.position);
  const history = usePaperTrading((s) => s.history);
  const reset = usePaperTrading((s) => s.reset);
  const chartSymbol = useChartStore((s) => s.symbol);

  useEffect(() => {
    startPriceMonitor();
  }, []);

  // Unrealized P&L
  let unrealizedPnl = 0;
  let unrealizedPct = 0;
  const showPosition = position && position.symbol === chartSymbol;

  if (showPosition && livePrice) {
    const diff =
      position.side === "long"
        ? livePrice - position.entryPrice
        : position.entryPrice - livePrice;
    unrealizedPnl = diff * position.qty;
    unrealizedPct = (unrealizedPnl / capital) * 100;
  }

  // Last closed trade
  const lastTrade = history.length > 0 ? history[history.length - 1] : null;

  const totalReturn = ((capital - startCapital) / startCapital) * 100;
  const wins = history.filter((t) => t.pnl > 0).length;
  const winRate = history.length > 0 ? (wins / history.length) * 100 : 0;

  return (
    <div className="absolute top-3 right-3 z-20 w-[220px]">
      <div className="rounded-xl bg-panel/90 backdrop-blur-md border border-border/40 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
          <div className="flex items-center gap-1.5">
            <Wallet size={12} className="text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Paper Trading
            </span>
          </div>
          <button
            onClick={reset}
            title="Reset"
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <RotateCcw size={11} />
          </button>
        </div>

        {/* Capital */}
        <div className="px-3 py-2 border-b border-border/20">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Capital</span>
            <span className="text-sm font-mono font-semibold text-foreground">
              ${formatPrice(capital)}
            </span>
          </div>
          <div className="flex items-baseline justify-between mt-0.5">
            <span className="text-[10px] text-muted-foreground/70">Retorno</span>
            <span
              className={`text-[11px] font-mono font-medium ${
                totalReturn >= 0 ? "text-bull" : "text-bear"
              }`}
            >
              {formatPct(totalReturn)}
            </span>
          </div>
          {history.length > 0 && (
            <div className="flex items-baseline justify-between mt-0.5">
              <span className="text-[10px] text-muted-foreground/70">
                {history.length} trades
              </span>
              <span className="text-[10px] text-muted-foreground/70">
                WR {winRate.toFixed(0)}%
              </span>
            </div>
          )}
        </div>

        {/* Open position */}
        {showPosition && (
          <div className="px-3 py-2 border-b border-border/20">
            <div className="flex items-center gap-1.5 mb-1.5">
              <CircleDot size={10} className="text-primary animate-pulse" />
              <span
                className={`text-[11px] font-bold ${
                  position.side === "long" ? "text-bull" : "text-bear"
                }`}
              >
                {position.side === "long" ? (
                  <TrendingUp size={10} className="inline mr-1" />
                ) : (
                  <TrendingDown size={10} className="inline mr-1" />
                )}
                {position.side.toUpperCase()} {position.symbol.replace("USDT", "")}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
              <span className="text-muted-foreground">Entrada</span>
              <span className="text-right font-mono text-foreground">
                {formatPrice(position.entryPrice)}
              </span>
              <span className="text-muted-foreground">SL</span>
              <span className="text-right font-mono text-bear">
                {formatPrice(position.sl)}
              </span>
              <span className="text-muted-foreground">TP</span>
              <span className="text-right font-mono text-bull">
                {formatPrice(position.tp)}
              </span>
              <span className="text-muted-foreground">P&L</span>
              <span
                className={`text-right font-mono font-semibold ${
                  unrealizedPnl >= 0 ? "text-bull" : "text-bear"
                }`}
              >
                {unrealizedPnl >= 0 ? "+" : ""}${unrealizedPnl.toFixed(2)} ({formatPct(unrealizedPct)})
              </span>
            </div>
          </div>
        )}

        {/* No position — show last trade */}
        {!position && lastTrade && (
          <div className="px-3 py-2">
            <span className="text-[10px] text-muted-foreground/60">Ultimo trade:</span>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[10px] text-muted-foreground">
                {lastTrade.side.toUpperCase()} {lastTrade.symbol.replace("USDT", "")}
              </span>
              <span
                className={`text-[11px] font-mono font-semibold ${
                  lastTrade.pnl >= 0 ? "text-bull" : "text-bear"
                }`}
              >
                {lastTrade.pnl >= 0 ? "+" : ""}${lastTrade.pnl.toFixed(2)}
              </span>
            </div>
            <span className="text-[9px] text-muted-foreground/50">{lastTrade.exitReason}</span>
          </div>
        )}

        {/* Empty state */}
        {!position && !lastTrade && (
          <div className="px-3 py-3 text-center">
            <span className="text-[10px] text-muted-foreground/50">
              Sin trades aun. Usa "Simular entrada" en un par con senal.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
