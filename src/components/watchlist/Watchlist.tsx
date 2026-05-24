"use client";

import { useEffect, useState } from "react";
import { Star, Plus, MoreHorizontal, X } from "lucide-react";
import { fetchTickers24h } from "@/lib/binance/rest";
import { getBinanceWS } from "@/lib/binance/ws";
import { useChartStore } from "@/lib/store/chart-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatPrice, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Row {
  symbol: string;
  price: number;
  pct: number;
}

const ASSET_META: Record<string, { icon: string; iconBg: string; name: string }> = {
  BTCUSDT:  { icon: "₿", iconBg: "#f7931a", name: "Bitcoin" },
  ETHUSDT:  { icon: "Ξ", iconBg: "#627eea", name: "Ethereum" },
  SOLUSDT:  { icon: "◎", iconBg: "#14f195", name: "Solana" },
  BNBUSDT:  { icon: "B", iconBg: "#f3ba2f", name: "BNB" },
  XRPUSDT:  { icon: "X", iconBg: "#23292f", name: "Ripple" },
  DOGEUSDT: { icon: "D", iconBg: "#c3a634", name: "Dogecoin" },
  ADAUSDT:  { icon: "A", iconBg: "#0033ad", name: "Cardano" },
  AVAXUSDT: { icon: "A", iconBg: "#e84142", name: "Avalanche" },
  LINKUSDT: { icon: "L", iconBg: "#2a5ada", name: "Chainlink" },
  MATICUSDT:{ icon: "M", iconBg: "#8247e5", name: "Polygon" },
};

export function Watchlist() {
  const watchlist = useChartStore((s) => s.watchlist);
  const symbol = useChartStore((s) => s.symbol);
  const setSymbol = useChartStore((s) => s.setSymbol);
  const removeFromWatchlist = useChartStore((s) => s.removeFromWatchlist);
  const openSymbolDialog = useChartStore((s) => s.setSymbolDialogOpen);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [flash, setFlash] = useState<Record<string, "up" | "down" | null>>({});

  useEffect(() => {
    if (watchlist.length === 0) return;
    let cancelled = false;

    fetchTickers24h(watchlist)
      .then((tickers) => {
        if (cancelled) return;
        const map: Record<string, Row> = {};
        tickers.forEach((t) => {
          map[t.symbol] = {
            symbol: t.symbol,
            price: t.lastPrice,
            pct: t.priceChangePercent,
          };
        });
        setRows(map);
      })
      .catch(console.error);

    const ws = getBinanceWS();
    const unsub = ws.subscribeMiniTickers(watchlist, (tick) => {
      setRows((prev) => {
        const prevRow = prev[tick.symbol];
        if (prevRow) {
          if (tick.close > prevRow.price) {
            setFlash((f) => ({ ...f, [tick.symbol]: "up" }));
            setTimeout(() => setFlash((f) => ({ ...f, [tick.symbol]: null })), 300);
          } else if (tick.close < prevRow.price) {
            setFlash((f) => ({ ...f, [tick.symbol]: "down" }));
            setTimeout(() => setFlash((f) => ({ ...f, [tick.symbol]: null })), 300);
          }
        }
        return {
          ...prev,
          [tick.symbol]: {
            symbol: tick.symbol,
            price: tick.close,
            pct: tick.pct,
          },
        };
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [watchlist]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Star className="w-3.5 h-3.5 text-primary" fill="currentColor" />
          <span className="text-xs font-semibold uppercase tracking-wider">Lista de seguimiento</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <button
            onClick={() => openSymbolDialog(true)}
            className="hover:text-foreground"
            title="Agregar símbolo"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button className="hover:text-foreground">
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_auto] px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
        <span>Símbolo</span>
        <span className="text-right pr-3">Último</span>
        <span className="text-right w-16">24h %</span>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col">
          {watchlist.map((s) => {
            const row = rows[s];
            const isActive = s === symbol;
            const f = flash[s];
            const meta = ASSET_META[s];
            const up = row ? row.pct >= 0 : true;

            return (
              <div
                key={s}
                onClick={() => setSymbol(s)}
                role="button"
                tabIndex={0}
                className={cn(
                  "group w-full grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 text-left border-b border-border/50 transition cursor-pointer",
                  isActive ? "bg-accent" : "hover:bg-panel-hover",
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {meta ? (
                    <span
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{ backgroundColor: meta.iconBg, color: "#0b0e14" }}
                    >
                      {meta.icon}
                    </span>
                  ) : (
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-muted text-muted-foreground">
                      {s.charAt(0)}
                    </span>
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{s.replace("USDT", "")}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {meta?.name ?? s}
                    </div>
                  </div>
                </div>

                <div
                  className={cn(
                    "font-mono text-xs text-right pr-3 tabular-nums transition-colors",
                    f === "up" && "text-bull",
                    f === "down" && "text-bear",
                    !f && "text-foreground",
                  )}
                >
                  {row ? formatPrice(row.price) : "—"}
                </div>

                <div className="flex items-center justify-end gap-1">
                  <span
                    className={cn(
                      "font-mono text-xs text-right w-16 px-1.5 py-0.5 rounded tabular-nums",
                      row
                        ? up
                          ? "text-bull bg-bull/10"
                          : "text-bear bg-bear/10"
                        : "text-muted-foreground",
                    )}
                  >
                    {row ? formatPct(row.pct) : "—"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromWatchlist(s);
                    }}
                    className="invisible rounded p-0.5 text-muted-foreground hover:bg-background hover:text-bear group-hover:visible"
                    aria-label={`Quitar ${s} del watchlist`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
          {watchlist.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              Tu watchlist está vacío
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Market summary */}
      <div className="border-t border-border p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Resumen del mercado</div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Dominancia BTC</span>
          <span className="font-mono text-foreground">52.4%</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span className="text-muted-foreground">Miedo y codicia</span>
          <span className="font-mono text-bull">72 · Codicia</span>
        </div>
      </div>
    </div>
  );
}
