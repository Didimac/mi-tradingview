"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { fetchKlines } from "@/lib/binance/rest";
import {
  scoreOpportunityDual,
  calcBtcRegime,
  isAlertEligible,
  type OpportunityScore,
  type BtcRegime,
} from "@/lib/scoring/opportunityScorer";
import {
  registerOpportunity,
  updateScore,
  startOpportunityWatcher,
  canSendPhase1,
  getActiveOpportunity,
} from "@/lib/telegram/opportunityWatcher";
import { useChartStore } from "@/lib/store/chart-store";
import { usePaperTrading } from "@/lib/papertrading/paperTradingEngine";
import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/format";
import { TrendingUp, TrendingDown, Minus, RefreshCw, BarChart3, ChevronUp, ChevronDown, Eye } from "lucide-react";

const SCORE_CANCEL_THRESHOLD = 40;

const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT",
];

export type { OpportunityScore };

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 125) * 100);
  const color =
    score >= 60 ? "bg-bull" : score >= 40 ? "bg-yellow-500" : "bg-bear";
  return (
    <div className="h-1.5 w-12 rounded-full bg-border/40 overflow-hidden">
      <div
        className={cn("h-full rounded-full transition-all duration-500", color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function DirIcon({ dir }: { dir: OpportunityScore["direction"] }) {
  if (dir === "LONG") return <TrendingUp size={10} className="text-bull" />;
  if (dir === "SHORT") return <TrendingDown size={10} className="text-bear" />;
  return <Minus size={10} className="text-muted-foreground/40" />;
}

function ScoreCell({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "text-[10px] font-mono font-bold tabular-nums",
        value >= 30 ? "text-bull" : value >= 15 ? "text-yellow-500" : "text-muted-foreground/50",
      )}
    >
      {value}
    </span>
  );
}

export function useOpportunityScores() {
  const [scores, setScores] = useState<OpportunityScore[]>([]);
  const [regime, setRegime] = useState<BtcRegime>("BULL");
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const prevHighRef = useRef<Set<string>>(new Set());
  const addToast = usePaperTrading((s) => s.addToast);
  const capital = usePaperTrading((s) => s.capital);

  // Start watcher on mount
  useEffect(() => {
    startOpportunityWatcher();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const btcDaily = await fetchKlines("BTCUSDT", "1d", 210);
      const btcRegime = calcBtcRegime(btcDaily);
      setRegime(btcRegime);

      const results = await Promise.all(
        PAIRS.map(async (symbol) => {
          const c1h = await fetchKlines(symbol, "1h", 300);
          return scoreOpportunityDual(symbol, c1h, [], btcRegime, capital);
        }),
      );
      results.sort((a, b) => b.score - a.score);
      setScores(results);
      setLastUpdate(new Date());

      const currentHigh = new Set<string>();
      for (const r of results) {
        if (r.score >= 60) {
          currentHigh.add(r.symbol);
          if (!prevHighRef.current.has(r.symbol)) {
            addToast("signal", `${r.symbol.replace("USDT", "")} score ${r.score}/125 ${r.direction}`);
          }
        }

        // Auto paper trading: score >= 75 → auto-enter trade
        if (isAlertEligible(r) && canSendPhase1(r.symbol)) {
          registerOpportunity(r);
        }

        // Log score drops for active opportunities
        if (r.score < SCORE_CANCEL_THRESHOLD) {
          const active = getActiveOpportunity(r.symbol);
          if (active) {
            updateScore(r.symbol, r.score);
          }
        }
      }
      prevHighRef.current = currentHigh;
    } catch {
      // silently ignore
    }
    setLoading(false);
  }, [addToast, capital]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15 * 60 * 1000); // cada 15 min
    return () => clearInterval(id);
  }, [refresh]);

  return { scores, regime, loading, lastUpdate, refresh };
}

export function OpportunityBoard() {
  const setSymbol = useChartStore((s) => s.setSymbol);
  const currentSymbol = useChartStore((s) => s.symbol);
  const { scores, regime, loading, lastUpdate, refresh } = useOpportunityScores();
  const panelState = useChartStore((s) => s.panels.opportunities);
  const toggleMinimized = useChartStore((s) => s.togglePanelMinimized);

  const setSelectedScore = useChartStore((s) => s.setSelectedScore);

  const handleRowClick = (s: OpportunityScore) => {
    setSymbol(s.symbol);
    setSelectedScore(s);
  };

  if (!panelState.visible) return null;

  return (
    <div className="flex flex-col h-full bg-panel border-t border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
        <div className="flex items-center gap-1.5">
          <BarChart3 size={12} className="text-primary" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Oportunidades
          </span>
          <span
            className={cn(
              "text-[9px] font-bold px-1.5 py-0.5 rounded",
              regime === "BULL"
                ? "bg-bull/20 text-bull"
                : "bg-bear/20 text-bear",
            )}
          >
            BTC {regime}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdate && (
            <span className="text-[9px] text-muted-foreground/50">
              {lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:opacity-30"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => toggleMinimized("opportunities")}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title={panelState.minimized ? "Expandir" : "Colapsar"}
          >
            {panelState.minimized ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>
      </div>

      {/* Table header */}
      {!panelState.minimized && (
      <div className="grid grid-cols-[55px_35px_18px_26px_26px_26px_26px_50px_50px_50px_50px] gap-0.5 px-2 py-1 text-[8px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/20">
        <span>Par</span>
        <span className="text-right">Score</span>
        <span className="text-center">Dir</span>
        <span className="text-center">FR</span>
        <span className="text-center">Div</span>
        <span className="text-center">VW</span>
        <span className="text-center">SSL</span>
        <span className="text-right">Lotaje</span>
        <span className="text-right">SL</span>
        <span className="text-right">TP1</span>
        <span className="text-right">TP2</span>
      </div>
      )}

      {/* Rows */}
      {!panelState.minimized && (
      <div className="flex-1 overflow-y-auto min-h-0">
        {scores.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-[10px] text-muted-foreground/40">
              {loading ? "Analizando 8 pares..." : "Sin datos"}
            </span>
          </div>
        )}
        {scores.map((s) => (
          <button
            key={s.symbol}
            onClick={() => handleRowClick(s)}
            className={cn(
              "grid grid-cols-[55px_35px_18px_26px_26px_26px_26px_50px_50px_50px_50px] gap-0.5 w-full px-2 py-1 items-center text-left transition-colors hover:bg-border/20",
              s.symbol === currentSymbol && "bg-border/30",
            )}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold text-foreground flex items-center gap-0.5">
                {s.symbol.replace("USDT", "")}
                {getActiveOpportunity(s.symbol) && (
                  <Eye size={8} className="text-primary animate-pulse" />
                )}
              </span>
              <ScoreBar score={s.score} />
            </div>
            <span
              className={cn(
                "text-right text-[11px] font-mono font-bold tabular-nums",
                s.score >= 60 ? "text-bull" : s.score >= 40 ? "text-yellow-500" : "text-muted-foreground",
              )}
            >
              {s.score}
            </span>
            <span className="flex justify-center">
              <DirIcon dir={s.direction} />
            </span>
            <span className="flex justify-center"><ScoreCell value={s.components.fundingRate} /></span>
            <span className="flex justify-center"><ScoreCell value={s.components.rsiDivergence} /></span>
            <span className="flex justify-center"><ScoreCell value={s.components.vwapWeekly} /></span>
            <span className="flex justify-center"><ScoreCell value={s.components.ssl} /></span>
            <span className="text-right text-[9px] font-mono text-muted-foreground tabular-nums">
              {s.positionUSDT > 0 ? `$${s.positionUSDT.toFixed(0)}` : "–"}
            </span>
            <span className="text-right text-[9px] font-mono text-bear tabular-nums">
              {s.stopLoss > 0 ? formatPrice(s.stopLoss) : "–"}
            </span>
            <span className="text-right text-[9px] font-mono text-yellow-500 tabular-nums">
              {s.takeProfit1 > 0 ? formatPrice(s.takeProfit1) : "–"}
            </span>
            <span className="text-right text-[9px] font-mono text-bull tabular-nums">
              {s.takeProfit2 > 0 ? formatPrice(s.takeProfit2) : "–"}
            </span>
          </button>
        ))}
      </div>
      )}
    </div>
  );
}
