"use client";

import { useEffect, useRef, useCallback, useState } from "react";
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
  X,
  Minus,
  GripHorizontal,
  Bot,
  User,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function PaperTradingOverlay({ livePrice }: { livePrice: number | null }) {
  const capital = usePaperTrading((s) => s.capital);
  const startCapital = usePaperTrading((s) => s.startCapital);
  const position = usePaperTrading((s) => s.position);
  const history = usePaperTrading((s) => s.history);
  const reset = usePaperTrading((s) => s.reset);
  const openTrade = usePaperTrading((s) => s.openTrade);
  const autoMode = usePaperTrading((s) => s.autoMode);
  const tradingMode = usePaperTrading((s) => s.tradingMode);
  const setAutoMode = usePaperTrading((s) => s.setAutoMode);
  const chartSymbol = useChartStore((s) => s.symbol);
  const panelState = useChartStore((s) => s.panels.paperTrading);
  const toggleVisible = useChartStore((s) => s.togglePanelVisible);
  const toggleMinimized = useChartStore((s) => s.togglePanelMinimized);
  const setPanelPosition = useChartStore((s) => s.setPanelPosition);

  // Drag logic
  const dragRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    dragging.current = true;
    const rect = dragRef.current.getBoundingClientRect();
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const x = e.clientX - offset.current.x;
      const y = e.clientY - offset.current.y;
      if (dragRef.current) {
        dragRef.current.style.left = `${x}px`;
        dragRef.current.style.top = `${y}px`;
        dragRef.current.style.right = "auto";
      }
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (dragRef.current) {
        const rect = dragRef.current.getBoundingClientRect();
        setPanelPosition("paperTrading", rect.left, rect.top);
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [setPanelPosition]);

  const [serverSync, setServerSync] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);

  useEffect(() => {
    startPriceMonitor();
  }, []);

  // Sync with server state (Vercel Blob) every 30s
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
          // Sync server state into local Zustand store (server is source of truth)
          const store = usePaperTrading.getState();
          if (data.capital !== store.capital || data.autoMode !== store.autoMode) {
            if (data.capital) usePaperTrading.setState({ capital: data.capital });
            if (typeof data.autoMode === "boolean") usePaperTrading.setState({ autoMode: data.autoMode });
          }
          // Sync position from server if different
          const serverPos = data.position;
          const localPos = store.position;
          if (serverPos && !localPos) {
            // Server has position, local doesn't → sync
            usePaperTrading.setState({
              position: {
                ...serverPos,
                tp: serverPos.tp1,
              },
            });
          } else if (!serverPos && localPos) {
            // Server closed position → sync
            usePaperTrading.setState({ position: null });
          }
          if (data.history?.length > store.history.length) {
            usePaperTrading.setState({ history: data.history });
          }
        }
      } catch {
        setServerSync(false);
      }
    };
    syncFromServer();
    const id = setInterval(syncFromServer, 30_000);
    return () => clearInterval(id);
  }, []);

  // Sync autoMode toggle TO server
  const handleAutoModeToggle = useCallback(async (on: boolean) => {
    setAutoMode(on);
    try {
      await fetch("/api/paper-trading/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMode: on }),
      });
    } catch {
      // local state already updated
    }
  }, [setAutoMode]);

  // Poll for pending trades from Telegram webhook
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/trades/pending");
        const data = await res.json();
        if (data.trades?.length > 0) {
          for (const t of data.trades) {
            openTrade({
              symbol: t.symbol,
              side: t.side,
              price: t.price,
              sl: t.sl,
              tp: t.tp1,
              tp2: t.tp2 ?? t.tp1,
              reason: t.reason,
            });
          }
        }
      } catch {}
    };
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
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

  if (!panelState.visible) return null;

  const posStyle: React.CSSProperties =
    panelState.x >= 0 && panelState.y >= 0
      ? { left: panelState.x, top: panelState.y, right: "auto" }
      : { top: 12, right: 12 };

  return (
    <div ref={dragRef} className="absolute z-20 w-[220px]" style={posStyle}>
      <div className="rounded-xl bg-panel/90 backdrop-blur-md border border-border/40 shadow-2xl overflow-hidden">
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-border/30 cursor-grab active:cursor-grabbing select-none"
          onMouseDown={onMouseDown}
        >
          <div className="flex items-center gap-1.5">
            <GripHorizontal size={10} className="text-muted-foreground/40" />
            <Wallet size={12} className="text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Paper Trading
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={reset}
              title="Reset"
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <RotateCcw size={11} />
            </button>
            <button
              onClick={() => toggleMinimized("paperTrading")}
              title="Minimizar"
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <Minus size={11} />
            </button>
            <button
              onClick={() => toggleVisible("paperTrading")}
              title="Cerrar"
              className="text-muted-foreground/50 hover:text-bear transition-colors"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        {/* Body — hidden when minimized */}
        {!panelState.minimized && (
          <>
            {/* Mode toggle */}
            <div
              className={cn(
                "px-3 py-1.5 border-b border-border/20 flex items-center justify-between",
                tradingMode === "real"
                  ? "bg-yellow-500/10"
                  : autoMode
                    ? "bg-bull/10"
                    : "bg-muted/30",
              )}
            >
              <div className="flex items-center gap-1.5">
                {tradingMode === "real" ? (
                  <>
                    <DollarSign size={10} className="text-yellow-500" />
                    <span className="text-[9px] font-bold text-yellow-500 uppercase tracking-wider">
                      Real
                    </span>
                  </>
                ) : autoMode ? (
                  <>
                    <Bot size={10} className="text-bull" />
                    <span className="text-[9px] font-bold text-bull uppercase tracking-wider">
                      Auto ON
                    </span>
                  </>
                ) : (
                  <>
                    <User size={10} className="text-muted-foreground" />
                    <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
                      Manual
                    </span>
                  </>
                )}
              </div>

              {/* Toggle — only in paper mode */}
              {tradingMode === "paper" && (
                <button
                  onClick={() => handleAutoModeToggle(!autoMode)}
                  className={cn(
                    "relative w-7 h-3.5 rounded-full transition-colors duration-200",
                    autoMode ? "bg-bull" : "bg-border",
                  )}
                  title={autoMode ? "Desactivar modo auto" : "Activar modo auto"}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform duration-200",
                      autoMode ? "translate-x-3.5" : "translate-x-0.5",
                    )}
                  />
                </button>
              )}

              {/* Real money mode — lock indicator */}
              {tradingMode === "real" && (
                <span className="text-[8px] text-yellow-500/70">Siempre manual</span>
              )}

              {/* Server sync indicator */}
              {tradingMode !== "real" && (
                <div className="flex items-center gap-1">
                  <span className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    serverSync ? "bg-bull animate-pulse" : "bg-muted-foreground/30",
                  )} />
                  <span className="text-[8px] text-muted-foreground/50">
                    {serverSync ? (lastScan ? `Scan ${lastScan}` : "Server OK") : "Sin server"}
                  </span>
                </div>
              )}
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
                  <span className="text-muted-foreground">SL{position.partialClosed ? " (BE)" : ""}</span>
                  <span className="text-right font-mono text-bear">
                    {formatPrice(position.sl)}
                  </span>
                  <span className="text-muted-foreground">TP1{position.partialClosed ? " ✓" : ""}</span>
                  <span className={`text-right font-mono ${position.partialClosed ? "text-muted-foreground line-through" : "text-bull"}`}>
                    {formatPrice(position.tp)}
                  </span>
                  <span className="text-muted-foreground">TP2</span>
                  <span className="text-right font-mono text-bull">
                    {formatPrice(position.tp2)}
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

            {/* No position — show trade history */}
            {!position && history.length > 0 && (
              <div className="px-3 py-2">
                <span className="text-[10px] text-muted-foreground/60 font-semibold">
                  Historial ({history.length} {history.length === 1 ? "trade" : "trades"})
                </span>

                {/* Show last 3 trades */}
                <div className="mt-1 space-y-1.5">
                  {history.slice(-3).reverse().map((t) => (
                    <div key={t.id} className="border-b border-border/10 pb-1 last:border-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          {t.side === "long" ? (
                            <TrendingUp size={9} className="text-bull" />
                          ) : (
                            <TrendingDown size={9} className="text-bear" />
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {t.symbol.replace("USDT", "")}
                          </span>
                        </div>
                        <span
                          className={`text-[11px] font-mono font-semibold ${
                            t.pnl >= 0 ? "text-bull" : "text-bear"
                          }`}
                        >
                          {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-[9px] text-muted-foreground/50">
                          {t.exitReason}
                        </span>
                        <span className="text-[9px] text-muted-foreground/40">
                          ${formatPrice(t.entryPrice)} → ${formatPrice(t.exitPrice)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
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
          </>
        )}
      </div>
    </div>
  );
}
