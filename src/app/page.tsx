"use client";

import { Header } from "@/components/layout/Header";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { RightSidebar } from "@/components/layout/RightSidebar";
import { BottomPanel } from "@/components/layout/BottomPanel";
import { PriceChart } from "@/components/chart/PriceChart";
import { IndicatorSettingsDialog } from "@/components/chart/IndicatorSettingsDialog";
import { OpportunityBoard } from "@/components/scoring/OpportunityBoard";
import { useChartStore } from "@/lib/store/chart-store";
import { ToastContainer } from "@/components/papertrading/ToastContainer";

export default function HomePage() {
  const symbol = useChartStore((s) => s.symbol);
  const timeframe = useChartStore((s) => s.timeframe);
  const oppVisible = useChartStore((s) => s.panels.opportunities.visible);
  const oppMinimized = useChartStore((s) => s.panels.opportunities.minimized);

  return (
    <div className="dark h-screen flex flex-col bg-background text-foreground">
      <Header />
      <div className="flex-1 flex min-h-0">
        <LeftSidebar />
        <main className="relative flex min-h-0 flex-1 flex-col">
          <div className={`min-h-0 ${oppVisible && !oppMinimized ? "flex-[3]" : "flex-1"}`}>
            <PriceChart symbol={symbol} timeframe={timeframe} />
          </div>
          {oppVisible && (
            <div className={`min-h-0 ${oppMinimized ? "flex-none" : "flex-[1] max-h-[260px]"}`}>
              <OpportunityBoard />
            </div>
          )}
        </main>
        <RightSidebar />
      </div>
      <BottomPanel />
      <IndicatorSettingsDialog />
      <ToastContainer />
    </div>
  );
}
