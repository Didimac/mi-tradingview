"use client";

import { useEffect, useState } from "react";
import { useChartStore } from "@/lib/store/chart-store";
import { fetchTicker24h } from "@/lib/binance/rest";
import type { Ticker24h } from "@/lib/binance/types";
import { formatPrice, formatPct, formatVolume } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SignalButton } from "@/components/papertrading/SignalButton";

function fmt(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function BottomPanel() {
  const symbol = useChartStore((s) => s.symbol);
  const [t, setT] = useState<Ticker24h | null>(null);

  useEffect(() => {
    let cancelled = false;
    setT(null);
    const load = () => {
      fetchTicker24h(symbol)
        .then((x) => {
          if (!cancelled) setT(x);
        })
        .catch(console.error);
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  const up = t ? t.priceChangePercent >= 0 : true;

  return (
    <div className="h-14 bg-panel border-t border-border flex items-center px-4 gap-6 shrink-0 overflow-x-auto">
      <Stat
        label="Precio"
        value={t ? formatPrice(t.lastPrice) : "—"}
        accent={up ? "bull" : "bear"}
        big
      />
      <Stat
        label="Cambio 24h"
        value={t ? `${up ? "+" : ""}${formatPrice(t.priceChange)} (${formatPct(t.priceChangePercent)})` : "—"}
        accent={up ? "bull" : "bear"}
      />
      <Stat
        label="Máx 24h"
        value={t ? formatPrice(t.highPrice) : "—"}
        accent="bull"
      />
      <Stat
        label="Mín 24h"
        value={t ? formatPrice(t.lowPrice) : "—"}
        accent="bear"
      />
      <Stat
        label="Volumen 24h"
        value={t ? fmt(t.quoteVolume) + " USDT" : "—"}
      />

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-bull mr-1" />
        <span className="text-[10px] text-muted-foreground">Binance · Live</span>
      </div>

      <SignalButton />
    </div>
  );
}

function Stat({ label, value, accent, big }: { label: string; value: string; accent?: "bull" | "bear"; big?: boolean }) {
  const color = accent === "bull" ? "text-bull" : accent === "bear" ? "text-bear" : "text-foreground";
  return (
    <div className="flex flex-col whitespace-nowrap">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", big ? "text-base font-bold" : "text-sm font-semibold", color)}>
        {value}
      </span>
    </div>
  );
}
