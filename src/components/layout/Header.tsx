"use client";

import { useState, useEffect } from "react";
import { Search, ChevronDown, Bell, Camera, Save, Settings, BarChart3, LineChart } from "lucide-react";
import { SymbolSelector } from "@/components/chart/SymbolSelector";
import { TimeframeSelector } from "@/components/chart/TimeframeSelector";
import { IndicatorMenu } from "@/components/chart/IndicatorMenu";
import { fetchKlines } from "@/lib/binance/rest";
import { calcBtcRegime, type BtcRegime } from "@/lib/scoring/opportunityScorer";

function ToolbarBtn({ icon, label, highlight }: { icon: React.ReactNode; label: string; highlight?: boolean }) {
  return (
    <button
      title={label}
      className={`flex items-center gap-1.5 h-8 px-2.5 rounded text-xs hover:bg-panel-hover transition ${
        highlight ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function BtcRegimeIndicator() {
  const [regime, setRegime] = useState<BtcRegime | null>(null);

  useEffect(() => {
    fetchKlines("BTCUSDT", "1d", 210)
      .then((candles) => setRegime(calcBtcRegime(candles)))
      .catch(() => {});
  }, []);

  if (!regime) return null;

  return (
    <span
      className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded ${
        regime === "BULL"
          ? "bg-bull/20 text-bull"
          : "bg-bear/20 text-bear"
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${
        regime === "BULL" ? "bg-bull" : "bg-bear"
      }`} />
      BTC {regime}
    </span>
  );
}

export function Header() {
  return (
    <header className="h-11 bg-panel border-b border-border flex items-center px-2 gap-1 text-foreground shrink-0">
      <SymbolSelector />

      <div className="w-px h-5 bg-border mx-1" />

      <TimeframeSelector />

      <div className="w-px h-5 bg-border mx-1" />

      <ToolbarBtn icon={<LineChart className="w-4 h-4" />} label="Tipo de gr&#225;fico" />
      <IndicatorMenu />
      <ToolbarBtn icon={<Bell className="w-4 h-4" />} label="Alertas" />

      <div className="w-px h-5 bg-border mx-1" />
      <BtcRegimeIndicator />

      <div className="flex-1" />

      <ToolbarBtn icon={<Camera className="w-4 h-4" />} label="Captura" />
      <ToolbarBtn icon={<Save className="w-4 h-4" />} label="Guardar" />
      <ToolbarBtn icon={<Settings className="w-4 h-4" />} label="Ajustes" />

      <button className="ml-2 h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition">
        Publicar
      </button>
    </header>
  );
}
