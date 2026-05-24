"use client";

import { Watchlist } from "@/components/watchlist/Watchlist";

export function RightSidebar() {
  return (
    <aside className="w-[280px] bg-panel border-l border-border flex flex-col shrink-0">
      <Watchlist />
    </aside>
  );
}
