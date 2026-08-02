"use client";

import { useState } from "react";
import { Star, Wallet } from "lucide-react";
import { Watchlist } from "@/components/watchlist/Watchlist";
import { PaperTradingPanel } from "@/components/papertrading/PaperTradingPanel";
import { cn } from "@/lib/utils";
import { usePaperTrading } from "@/lib/papertrading/paperTradingEngine";

type Tab = "watchlist" | "trading";

export function RightSidebar() {
  const [tab, setTab] = useState<Tab>("trading");
  const allPositions = usePaperTrading((s) => s.position);
  const autoMode = usePaperTrading((s) => s.autoMode);

  return (
    <aside className="w-[280px] bg-panel border-l border-border flex flex-col shrink-0">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab("trading")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors border-b-2",
            tab === "trading"
              ? "text-primary border-primary bg-primary/5"
              : "text-muted-foreground border-transparent hover:text-foreground hover:bg-border/10",
          )}
        >
          <Wallet size={12} />
          Trading
          {(allPositions || autoMode) && (
            <span className={cn("w-1.5 h-1.5 rounded-full", autoMode ? "bg-bull animate-pulse" : "bg-primary")} />
          )}
        </button>
        <button
          onClick={() => setTab("watchlist")}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors border-b-2",
            tab === "watchlist"
              ? "text-primary border-primary bg-primary/5"
              : "text-muted-foreground border-transparent hover:text-foreground hover:bg-border/10",
          )}
        >
          <Star size={12} />
          Watchlist
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === "trading" ? <PaperTradingPanel /> : <Watchlist />}
      </div>
    </aside>
  );
}
