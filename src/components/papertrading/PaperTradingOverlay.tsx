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
  RefreshCw,
  ChevronDown,
  ChevronUp,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ServerPos {
  id: string; symbol: string; side: "long" | "short"; entryPrice: number;
  qty: number; sl: number; tp1: number; tp2: number; partialClosed: boolean;
  originalQty: number; entryTime: number; reason: string;
}

export function PaperTradingOverlay({ livePrice }: { livePrice: number | null }) {
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
  const panelState = useChartStore((s) => s.panels.paperTrading);
  const toggleVisible = useChartStore((s) => s.togglePanelVisible);
  const toggleMinimized = useChartStore((s) => s.togglePanelMinimized);
  const setPanelPosition = useChartStore((s) => s.setPanelPosition);

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
  const [serverPositions, setServerPositions] = useState<ServerPos[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

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

  // Close a server position manually
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

  // Close local position manually
  const closeLocalPosition = useCallback(() => {
    if (!position) return;
    const price = livePrices[position.symbol] ?? livePrice;
    if (!price) return;
    closeTrade(price, "Cierre manual");
  }, [position, livePrices, livePrice, closeTrade]);

  // Reload capital on server + local
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

  // Reset everything on server + local
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

  // Drawdown: max capital seen - current
  const maxCapital = history.reduce((max, t) => {
    const capAfter = startCapital + history.slice(0, history.indexOf(t) + 1).reduce((s, h) => s + h.pnl, 0);
    return Math.max(max, capAfter);
  }, startCapital);
  const drawdown = maxCapital > 0 ? ((maxCapital - capital) / maxCapital) * 100 : 0;

  // P&L for a position
  const calcPnl = (pos: { side: string; entryPrice: number; qty: number; symbol: string }) => {
    const price = livePrices[pos.symbol];
    if (!price) return { pnl: 0, pnlPct: 0, hasPrice: false };
    const diff = pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price;
    const pnl = diff * pos.qty;
    const pnlPct = capital > 0 ? (pnl / capital) * 100 : 0;
    return { pnl, pnlPct, hasPrice: true };
  };

  // All positions: server + local (deduplicated)
  const allPositions: Array<{ source: "server" | "local"; pos: ServerPos | null; localPos: typeof position }> = [];
  for (const sp of serverPositions) {
    allPositions.push({ source: "server", pos: sp, localPos: null });
  }
  if (position && !serverPositions.some((sp) => sp.id === position.id)) {
    allPositions.push({ source: "local", pos: null, localPos: position });
  }

  if (!panelState.visible) return null;

  const posStyle: React.CSSProperties =
    panelState.x >= 0 && panelState.y >= 0
      ? { left: panelState.x, top: panelState.y, right: "auto" }
      : { top: 12, right: 12 };

  return (
    <div ref={dragRef} className="absolute z-20 w-[250px]" style={posStyle}>
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
            <button onClick={() => toggleMinimized("paperTrading")} title="Minimizar" className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
              <Minus size={11} />
            </button>
            <button onClick={() => toggleVisible("paperTrading")} title="Cerrar" className="text-muted-foreground/50 hover:text-bear transition-colors">
              <X size={11} />
            </button>
          </div>
        </div>

        {!panelState.minimized && (
          <>
            {/* Mode toggle */}
            <div className={cn(
              "px-3 py-1.5 border-b border-border/20 flex items-center justify-between",
              tradingMode === "real" ? "bg-yellow-500/10" : autoMode ? "bg-bull/10" : "bg-muted/30",
            )}>
              <div className="flex items-center gap-1.5">
                {tradingMode === "real" ? (
                  <><DollarSign size={10} className="text-yellow-500" /><span className="text-[9px] font-bold text-yellow-500 uppercase tracking-wider">Real</span></>
                ) : autoMode ? (
                  <><Bot size={10} className="text-bull" /><span className="text-[9px] font-bold text-bull uppercase tracking-wider">Auto ON</span></>
                ) : (
                  <><User size={10} className="text-muted-foreground" /><span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Manual</span></>
                )}
              </div>
              {tradingMode === "paper" && (
                <button
                  onClick={() => handleAutoModeToggle(!autoMode)}
                  className={cn("relative w-7 h-3.5 rounded-full transition-colors duration-200", autoMode ? "bg-bull" : "bg-border")}
                  title={autoMode ? "Desactivar modo auto" : "Activar modo auto"}
                >
                  <span className={cn("absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform duration-200", autoMode ? "translate-x-3.5" : "translate-x-0.5")} />
                </button>
              )}
              {tradingMode === "real" && <span className="text-[8px] text-yellow-500/70">Siempre manual</span>}
              {tradingMode !== "real" && (
                <div className="flex items-center gap-1">
                  <span className={cn("w-1.5 h-1.5 rounded-full", serverSync ? "bg-bull animate-pulse" : "bg-muted-foreground/30")} />
                  <span className="text-[8px] text-muted-foreground/50">
                    {serverSync ? (lastScan ? `Scan ${lastScan}` : "Server OK") : "Sin server"}
                  </span>
                </div>
              )}
            </div>

            {/* Capital + Stats Dashboard */}
            <div className="px-3 py-2 border-b border-border/20">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">Capital</span>
                <span className="text-sm font-mono font-semibold text-foreground">${formatPrice(capital)}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-[9px] text-muted-foreground/60">P&L</span>
                  <span className={cn("text-[10px] font-mono font-medium", totalPnl >= 0 ? "text-bull" : "text-bear")}>
                    {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[9px] text-muted-foreground/60">Retorno</span>
                  <span className={cn("text-[10px] font-mono font-medium", totalReturn >= 0 ? "text-bull" : "text-bear")}>
                    {formatPct(totalReturn)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[9px] text-muted-foreground/60">Win Rate</span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {winRate.toFixed(0)}% ({wins}W/{losses}L)
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[9px] text-muted-foreground/60">Drawdown</span>
                  <span className={cn("text-[10px] font-mono", drawdown > 5 ? "text-bear" : "text-muted-foreground")}>
                    {drawdown.toFixed(1)}%
                  </span>
                </div>
              </div>
              {/* Action buttons */}
              <div className="flex gap-1.5 mt-2">
                <button
                  onClick={handleReloadCapital}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[9px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  title="Recargar capital a $1,000 (mantiene historial)"
                >
                  <RefreshCw size={9} />
                  Recargar $1K
                </button>
                <button
                  onClick={handleReset}
                  className="flex items-center justify-center gap-1 px-2 py-1 rounded text-[9px] font-medium bg-bear/10 text-bear hover:bg-bear/20 transition-colors"
                  title="Reset completo (borra historial)"
                >
                  <RotateCcw size={9} />
                  Reset
                </button>
              </div>
            </div>

            {/* Open Positions */}
            {allPositions.length > 0 && (
              <div className="px-3 py-2 border-b border-border/20">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <CircleDot size={10} className="text-primary animate-pulse" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Posiciones ({allPositions.length}/3)
                  </span>
                </div>
                <div className="space-y-1.5">
                  {allPositions.map((entry) => {
                    const isServer = entry.source === "server";
                    const sym = isServer ? entry.pos!.symbol : entry.localPos!.symbol;
                    const side = isServer ? entry.pos!.side : entry.localPos!.side;
                    const entryPrice = isServer ? entry.pos!.entryPrice : entry.localPos!.entryPrice;
                    const qty = isServer ? entry.pos!.qty : entry.localPos!.qty;
                    const sl = isServer ? entry.pos!.sl : entry.localPos!.sl;
                    const tp2 = isServer ? entry.pos!.tp2 : entry.localPos!.tp2;
                    const partialClosed = isServer ? entry.pos!.partialClosed : entry.localPos!.partialClosed;
                    const id = isServer ? entry.pos!.id : entry.localPos!.id;
                    const entryTime = isServer ? entry.pos!.entryTime : entry.localPos!.entryTime;
                    const { pnl, pnlPct, hasPrice } = calcPnl({ side, entryPrice, qty, symbol: sym });
                    const isClosing = closingId === id;
                    const elapsed = Math.floor((Date.now() - entryTime) / 60000);
                    const elapsedStr = elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed / 60)}h${elapsed % 60}m`;

                    return (
                      <div key={id} className="rounded-lg bg-border/10 p-1.5">
                        <div className="flex items-center justify-between">
                          <span className={cn("text-[11px] font-bold flex items-center gap-0.5", side === "long" ? "text-bull" : "text-bear")}>
                            {side === "long" ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                            {side.toUpperCase()} {sym.replace("USDT", "")}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-[8px] text-muted-foreground/40">{elapsedStr}</span>
                            <button
                              onClick={() => isServer ? closeServerPosition(entry.pos!) : closeLocalPosition()}
                              disabled={isClosing || !hasPrice}
                              className="text-muted-foreground/40 hover:text-bear transition-colors disabled:opacity-30"
                              title="Cerrar posicion al precio actual"
                            >
                              <XCircle size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-x-1 mt-1 text-[9px]">
                          <div>
                            <span className="text-muted-foreground/50">Entrada</span>
                            <div className="font-mono text-foreground">{formatPrice(entryPrice)}</div>
                          </div>
                          <div>
                            <span className="text-bear/70">SL{partialClosed ? " (BE)" : ""}</span>
                            <div className="font-mono text-bear">{formatPrice(sl)}</div>
                          </div>
                          <div>
                            <span className="text-bull/70">TP2</span>
                            <div className="font-mono text-bull">{formatPrice(tp2)}</div>
                          </div>
                        </div>
                        {hasPrice && (
                          <div className="flex items-center justify-between mt-1 pt-1 border-t border-border/10">
                            <span className="text-[9px] text-muted-foreground/50">P&L</span>
                            <span className={cn("text-[10px] font-mono font-bold", pnl >= 0 ? "text-bull" : "text-bear")}>
                              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No positions */}
            {allPositions.length === 0 && history.length === 0 && (
              <div className="px-3 py-3 text-center">
                <span className="text-[10px] text-muted-foreground/50">
                  Sin trades aun. Activa Auto ON y espera senales.
                </span>
              </div>
            )}

            {/* Trade History (collapsible) */}
            {history.length > 0 && (
              <div className="border-t border-border/20">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-border/10 transition-colors"
                >
                  <span className="text-[10px] text-muted-foreground/60 font-semibold">
                    Historial ({history.length} trades)
                  </span>
                  {showHistory ? <ChevronUp size={10} className="text-muted-foreground/40" /> : <ChevronDown size={10} className="text-muted-foreground/40" />}
                </button>
                {showHistory && (
                  <div className="px-3 pb-2 max-h-[200px] overflow-y-auto">
                    <div className="space-y-1">
                      {history.slice().reverse().map((t) => (
                        <div key={t.id} className="flex items-center justify-between py-0.5 border-b border-border/10 last:border-0">
                          <div className="flex items-center gap-1">
                            {t.side === "long" ? <TrendingUp size={8} className="text-bull" /> : <TrendingDown size={8} className="text-bear" />}
                            <span className="text-[9px] text-muted-foreground">{t.symbol.replace("USDT", "")}</span>
                            <span className="text-[8px] text-muted-foreground/40">{t.exitReason}</span>
                          </div>
                          <span className={cn("text-[10px] font-mono font-semibold", t.pnl >= 0 ? "text-bull" : "text-bear")}>
                            {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
