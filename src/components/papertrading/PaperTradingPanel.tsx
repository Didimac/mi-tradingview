"use client";

import { useEffect, useCallback, useState } from "react";
import {
  usePaperTrading,
  startPriceMonitor,
} from "@/lib/papertrading/paperTradingEngine";
import { useChartStore } from "@/lib/store/chart-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatPrice, formatPct } from "@/lib/format";
import {
  TrendingUp,
  TrendingDown,
  CircleDot,
  Bot,
  User,
  DollarSign,
  RefreshCw,
  RotateCcw,
  XCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Target,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ServerPos {
  id: string; symbol: string; side: "long" | "short"; entryPrice: number;
  qty: number; sl: number; tp1: number; tp2: number; partialClosed: boolean;
  originalQty: number; entryTime: number; reason: string;
}

export function PaperTradingPanel() {
  const capital = usePaperTrading((s) => s.capital);
  const startCapital = usePaperTrading((s) => s.startCapital);
  const position = usePaperTrading((s) => s.position);
  const history = usePaperTrading((s) => s.history);
  const reset = usePaperTrading((s) => s.reset);
  const openTrade = usePaperTrading((s) => s.openTrade);
  const closeTrade = usePaperTrading((s) => s.closeTrade);
  const autoMode = usePaperTrading((s) => s.autoMode);
  const tradingMode = usePaperTrading((s) => s.tradingMode);
  const setAutoMode = usePaperTrading((s) => s.setAutoMode);
  const reloadCapital = usePaperTrading((s) => s.reloadCapital);
  const livePrices = usePaperTrading((s) => s.livePrices);
  const chartSymbol = useChartStore((s) => s.symbol);

  const [serverSync, setServerSync] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [serverPositions, setServerPositions] = useState<ServerPos[]>([]);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(true);

  useEffect(() => { startPriceMonitor(); }, []);

  // Sync with server state every 30s
  useEffect(() => {
    const syncFromServer = async () => {
      try {
        const res = await fetch("/api/paper-trading/state");
        const data = await res.json();
        if (data.ok) {
          setServerSync(true);
          if (data.lastScanTime > 0) {
            setLastScan(new Date(data.lastScanTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
          }
          const store = usePaperTrading.getState();
          if (data.capital && data.capital !== store.capital) {
            usePaperTrading.setState({ capital: data.capital });
          }
          if (data.positions) setServerPositions(data.positions);
          const serverPos = data.position;
          const localPos = store.position;
          if (serverPos && !localPos) {
            usePaperTrading.setState({ position: { ...serverPos, tp: serverPos.tp1 } });
          }
          if (data.history?.length > store.history.length) {
            usePaperTrading.setState({ history: data.history });
          }
        }
      } catch { setServerSync(false); }
    };
    syncFromServer();
    const id = setInterval(syncFromServer, 30_000);
    return () => clearInterval(id);
  }, []);

  const handleAutoModeToggle = useCallback(async (on: boolean) => {
    setAutoMode(on);
    try {
      await fetch("/api/paper-trading/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMode: on }),
      });
    } catch {}
  }, [setAutoMode]);

  // Poll for pending trades from Telegram
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/trades/pending");
        const data = await res.json();
        if (data.trades?.length > 0) {
          for (const t of data.trades) {
            openTrade({ symbol: t.symbol, side: t.side, price: t.price, sl: t.sl, tp: t.tp1, tp2: t.tp2 ?? t.tp1, reason: t.reason });
          }
        }
      } catch {}
    };
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [openTrade]);

  const closeServerPosition = useCallback(async (pos: ServerPos) => {
    const price = livePrices[pos.symbol];
    if (!price) return;
    setClosingId(pos.id);
    try {
      await fetch("/api/paper-trading/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closePosition: { positionId: pos.id, exitPrice: price } }),
      });
      setServerPositions((prev) => prev.filter((p) => p.id !== pos.id));
    } catch {}
    setClosingId(null);
  }, [livePrices]);

  const closeLocalPosition = useCallback(() => {
    if (!position) return;
    const price = livePrices[position.symbol];
    if (!price) return;
    closeTrade(price, "Cierre manual");
  }, [position, livePrices, closeTrade]);

  const handleReloadCapital = useCallback(async () => {
    reloadCapital();
    try {
      await fetch("/api/paper-trading/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reloadCapital: true }),
      });
    } catch {}
  }, [reloadCapital]);

  const handleReset = useCallback(async () => {
    reset();
    try {
      await fetch("/api/paper-trading/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
    } catch {}
    setServerPositions([]);
  }, [reset]);

  // --- Calculations ---
  const totalReturn = ((capital - startCapital) / startCapital) * 100;
  const totalPnl = capital - startCapital;
  const wins = history.filter((t) => t.pnl > 0).length;
  const losses = history.filter((t) => t.pnl <= 0).length;
  const winRate = history.length > 0 ? (wins / history.length) * 100 : 0;
  const avgWin = wins > 0 ? history.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? history.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / losses : 0;

  const maxCapital = history.reduce((max, t) => {
    const capAfter = startCapital + history.slice(0, history.indexOf(t) + 1).reduce((s, h) => s + h.pnl, 0);
    return Math.max(max, capAfter);
  }, startCapital);
  const drawdown = maxCapital > 0 ? ((maxCapital - capital) / maxCapital) * 100 : 0;

  const calcPnl = (pos: { side: string; entryPrice: number; qty: number; symbol: string }) => {
    const price = livePrices[pos.symbol];
    if (!price) return { pnl: 0, pnlPct: 0, hasPrice: false, price: 0 };
    const diff = pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const pnl = diff * pos.qty;
    const pnlPct = capital > 0 ? (pnl / capital) * 100 : 0;
    return { pnl, pnlPct, hasPrice: true, price };
  };

  // All positions: server + local (deduplicated)
  const allPositions: Array<{ source: "server" | "local"; pos: ServerPos | null; localPos: typeof position }> = [];
  for (const sp of serverPositions) {
    allPositions.push({ source: "server", pos: sp, localPos: null });
  }
  if (position && !serverPositions.some((sp) => sp.id === position.id)) {
    allPositions.push({ source: "local", pos: null, localPos: position });
  }

  // Unrealized P&L across all positions
  const totalUnrealized = allPositions.reduce((sum, entry) => {
    const isServer = entry.source === "server";
    const sym = isServer ? entry.pos!.symbol : entry.localPos!.symbol;
    const side = isServer ? entry.pos!.side : entry.localPos!.side;
    const ep = isServer ? entry.pos!.entryPrice : entry.localPos!.entryPrice;
    const qty = isServer ? entry.pos!.qty : entry.localPos!.qty;
    const { pnl, hasPrice } = calcPnl({ side, entryPrice: ep, qty, symbol: sym });
    return sum + (hasPrice ? pnl : 0);
  }, 0);

  return (
    <div className="flex h-full flex-col">
      {/* Mode bar */}
      <div className={cn(
        "flex items-center justify-between px-3 py-2 border-b border-border",
        tradingMode === "real" ? "bg-yellow-500/10" : autoMode ? "bg-bull/10" : "",
      )}>
        <div className="flex items-center gap-2">
          {tradingMode === "real" ? (
            <><DollarSign size={14} className="text-yellow-500" /><span className="text-xs font-bold text-yellow-500">REAL</span></>
          ) : autoMode ? (
            <><Bot size={14} className="text-bull" /><span className="text-xs font-bold text-bull">AUTO ON</span></>
          ) : (
            <><User size={14} className="text-muted-foreground" /><span className="text-xs font-bold text-muted-foreground">MANUAL</span></>
          )}
        </div>
        <div className="flex items-center gap-2">
          {tradingMode === "paper" && (
            <button
              onClick={() => handleAutoModeToggle(!autoMode)}
              className={cn("relative w-9 h-5 rounded-full transition-colors duration-200", autoMode ? "bg-bull" : "bg-border")}
            >
              <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200", autoMode ? "translate-x-4" : "translate-x-0.5")} />
            </button>
          )}
          <div className="flex items-center gap-1">
            <span className={cn("w-2 h-2 rounded-full", serverSync ? "bg-bull animate-pulse" : "bg-muted-foreground/30")} />
            <span className="text-[10px] text-muted-foreground/60">
              {serverSync ? (lastScan ? `${lastScan}` : "OK") : "offline"}
            </span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col">
          {/* Capital card */}
          <div className="px-3 py-3 border-b border-border/50">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Capital</span>
              <span className="text-lg font-mono font-bold text-foreground">${formatPrice(capital)}</span>
            </div>
            {allPositions.length > 1 && totalUnrealized !== 0 && (
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-[10px] text-muted-foreground/50">No realizado ({allPositions.length} pos)</span>
                <span className={cn("text-xs font-mono font-medium", totalUnrealized >= 0 ? "text-bull" : "text-bear")}>
                  {totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(2)}
                </span>
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
              <StatRow label="P&L Total" value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`} color={totalPnl >= 0 ? "bull" : "bear"} />
              <StatRow label="Retorno" value={formatPct(totalReturn)} color={totalReturn >= 0 ? "bull" : "bear"} />
              <StatRow label="Win Rate" value={`${winRate.toFixed(0)}%`} sub={`${wins}W / ${losses}L`} />
              <StatRow label="Drawdown" value={`${drawdown.toFixed(1)}%`} color={drawdown > 5 ? "bear" : undefined} />
              {wins > 0 && <StatRow label="Avg Win" value={`+$${avgWin.toFixed(2)}`} color="bull" />}
              {losses > 0 && <StatRow label="Avg Loss" value={`$${avgLoss.toFixed(2)}`} color="bear" />}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleReloadCapital}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-semibold bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <RefreshCw size={11} />
                Recargar $1K
              </button>
              <button
                onClick={handleReset}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-semibold bg-bear/10 text-bear hover:bg-bear/20 transition-colors"
              >
                <RotateCcw size={11} />
                Reset
              </button>
            </div>
          </div>

          {/* Positions */}
          <div className="px-3 py-2 border-b border-border/50">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <CircleDot size={12} className={allPositions.length > 0 ? "text-primary animate-pulse" : "text-muted-foreground/30"} />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Posiciones
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground/50 font-mono">{allPositions.length}/3</span>
            </div>

            {allPositions.length === 0 ? (
              <div className="py-4 text-center">
                <span className="text-[11px] text-muted-foreground/40">
                  Sin posiciones abiertas
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {allPositions.map((entry) => {
                  const isServer = entry.source === "server";
                  const sym = isServer ? entry.pos!.symbol : entry.localPos!.symbol;
                  const side = isServer ? entry.pos!.side : entry.localPos!.side;
                  const entryPrice = isServer ? entry.pos!.entryPrice : entry.localPos!.entryPrice;
                  const qty = isServer ? entry.pos!.qty : entry.localPos!.qty;
                  const sl = isServer ? entry.pos!.sl : entry.localPos!.sl;
                  const tp1 = isServer ? entry.pos!.tp1 : entry.localPos!.tp;
                  const tp2 = isServer ? entry.pos!.tp2 : entry.localPos!.tp2;
                  const partialClosed = isServer ? entry.pos!.partialClosed : entry.localPos!.partialClosed;
                  const id = isServer ? entry.pos!.id : entry.localPos!.id;
                  const entryTime = isServer ? entry.pos!.entryTime : entry.localPos!.entryTime;
                  const { pnl, pnlPct, hasPrice, price: currentPrice } = calcPnl({ side, entryPrice, qty, symbol: sym });
                  const isClosing = closingId === id;
                  const elapsed = Math.floor((Date.now() - entryTime) / 60000);
                  const elapsedStr = elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed / 60)}h${elapsed % 60}m`;
                  const posSize = qty * entryPrice;
                  const entryDate = new Date(entryTime);
                  const entryDateStr = `${entryDate.getDate()}/${entryDate.getMonth() + 1} ${entryDate.getHours().toString().padStart(2, "0")}:${entryDate.getMinutes().toString().padStart(2, "0")}`;

                  return (
                    <div key={id} className="rounded-lg border border-border/30 overflow-hidden">
                      {/* Position header */}
                      <div className={cn(
                        "flex items-center justify-between px-2.5 py-1.5",
                        side === "long" ? "bg-bull/5" : "bg-bear/5",
                      )}>
                        <div className="flex items-center gap-1.5">
                          {side === "long" ? <TrendingUp size={12} className="text-bull" /> : <TrendingDown size={12} className="text-bear" />}
                          <span className={cn("text-xs font-bold", side === "long" ? "text-bull" : "text-bear")}>
                            {side.toUpperCase()} {sym.replace("USDT", "")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-muted-foreground/40">
                            <Clock size={9} />
                            <span className="text-[9px]">{elapsedStr}</span>
                          </div>
                          <button
                            onClick={() => isServer ? closeServerPosition(entry.pos!) : closeLocalPosition()}
                            disabled={isClosing || !hasPrice}
                            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium text-bear/60 hover:text-bear hover:bg-bear/10 transition-colors disabled:opacity-30"
                            title="Cerrar al precio actual"
                          >
                            <XCircle size={10} />
                            Cerrar
                          </button>
                        </div>
                      </div>

                      {/* Position body */}
                      <div className="px-2.5 py-2 space-y-1">
                        {/* Entry + Date */}
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground">Entrada</span>
                          <span className="font-mono text-foreground">${formatPrice(entryPrice)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground">Fecha</span>
                          <span className="font-mono text-muted-foreground/60">{entryDateStr}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground">Tamano</span>
                          <span className="font-mono text-muted-foreground">${posSize.toFixed(0)} USDT</span>
                        </div>

                        {/* SL / TP rows */}
                        <div className="space-y-0.5 mt-1">
                          <div className="flex items-center justify-between text-[10px] rounded px-1.5 py-0.5 bg-bear/5">
                            <span className="text-bear/70 flex items-center gap-1"><ShieldAlert size={9} />SL{partialClosed ? " (BE)" : ""}</span>
                            <span className="font-mono text-bear font-medium">${formatPrice(sl)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[10px] rounded px-1.5 py-0.5 bg-yellow-500/5">
                            <span className="text-yellow-500/70 flex items-center gap-1"><Target size={9} />TP1 (50%)</span>
                            <span className="font-mono text-yellow-500 font-medium">${formatPrice(tp1)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[10px] rounded px-1.5 py-0.5 bg-bull/5">
                            <span className="text-bull/70 flex items-center gap-1"><Target size={9} />TP2 (100%)</span>
                            <span className="font-mono text-bull font-medium">${formatPrice(tp2)}</span>
                          </div>
                        </div>

                        {/* Live P&L */}
                        <div className={cn(
                          "flex items-center justify-between rounded-md px-2 py-1.5 mt-1",
                          hasPrice ? (pnl >= 0 ? "bg-bull/10" : "bg-bear/10") : "bg-muted/20",
                        )}>
                          {hasPrice ? (
                            <>
                              <span className="text-[10px] text-muted-foreground">
                                Actual ${formatPrice(currentPrice)}
                              </span>
                              <span className={cn("text-sm font-mono font-bold", pnl >= 0 ? "text-bull" : "text-bear")}>
                                {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                                <span className="text-[10px] font-normal ml-1">({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)</span>
                              </span>
                            </>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/40 animate-pulse">Conectando precio...</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Trade History */}
          {history.length > 0 && (
            <div className="px-3 py-2">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="w-full flex items-center justify-between mb-2"
              >
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Historial ({history.length})
                </span>
                {showHistory ? <ChevronUp size={12} className="text-muted-foreground/40" /> : <ChevronDown size={12} className="text-muted-foreground/40" />}
              </button>
              {showHistory && (
                <div className="space-y-1">
                  {history.slice().reverse().map((t) => {
                    const date = new Date(t.exitTime);
                    const dateStr = `${date.getDate()}/${date.getMonth() + 1} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
                    return (
                      <div key={t.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-border/10 transition-colors border-b border-border/10 last:border-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {t.side === "long" ? <TrendingUp size={10} className="text-bull shrink-0" /> : <TrendingDown size={10} className="text-bear shrink-0" />}
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium text-foreground">
                              {t.symbol.replace("USDT", "")}
                              <span className="text-muted-foreground/40 ml-1.5 font-normal">{t.exitReason}</span>
                            </div>
                            <div className="text-[9px] text-muted-foreground/40 font-mono">
                              {formatPrice(t.entryPrice)} → {formatPrice(t.exitPrice)}
                              <span className="ml-1.5">{dateStr}</span>
                            </div>
                          </div>
                        </div>
                        <span className={cn("text-xs font-mono font-bold shrink-0 ml-2", t.pnl >= 0 ? "text-bull" : "text-bear")}>
                          {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {allPositions.length === 0 && history.length === 0 && (
            <div className="px-3 py-8 text-center">
              <Bot size={24} className="mx-auto text-muted-foreground/20 mb-2" />
              <p className="text-[11px] text-muted-foreground/40">
                Activa Auto ON y espera senales del scanner.
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function StatRow({ label, value, color, sub }: { label: string; value: string; color?: "bull" | "bear"; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-muted-foreground/60">{label}</span>
      <div className="text-right">
        <span className={cn(
          "text-[11px] font-mono font-medium",
          color === "bull" ? "text-bull" : color === "bear" ? "text-bear" : "text-foreground",
        )}>
          {value}
        </span>
        {sub && <span className="text-[9px] text-muted-foreground/40 ml-1">{sub}</span>}
      </div>
    </div>
  );
}
