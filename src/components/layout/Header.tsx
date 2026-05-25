"use client";

import { useState, useEffect, useRef } from "react";
import { Search, ChevronDown, Bell, Camera, Save, Settings, BarChart3, LineChart, LayoutDashboard, Eye, EyeOff } from "lucide-react";
import { SymbolSelector } from "@/components/chart/SymbolSelector";
import { TimeframeSelector } from "@/components/chart/TimeframeSelector";
import { IndicatorMenu } from "@/components/chart/IndicatorMenu";
import { fetchKlines } from "@/lib/binance/rest";
import { calcBtcRegime, type BtcRegime } from "@/lib/scoring/opportunityScorer";
import { useChartStore, type PanelKey } from "@/lib/store/chart-store";

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

const PANEL_LABELS: Record<PanelKey, string> = {
  paperTrading: "Paper Trading",
  opportunities: "Oportunidades",
  watchlist: "Lista de seguimiento",
};

function PanelMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panels = useChartStore((s) => s.panels);
  const togglePanelVisible = useChartStore((s) => s.togglePanelVisible);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded text-xs text-muted-foreground hover:bg-panel-hover transition"
      >
        <LayoutDashboard className="w-4 h-4" />
        <span className="hidden lg:inline">Paneles</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-panel border border-border rounded-lg shadow-xl z-50 py-1">
          {(Object.keys(PANEL_LABELS) as PanelKey[]).map((key) => (
            <button
              key={key}
              onClick={() => togglePanelVisible(key)}
              className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-panel-hover transition"
            >
              <span>{PANEL_LABELS[key]}</span>
              {panels[key].visible ? (
                <Eye size={12} className="text-primary" />
              ) : (
                <EyeOff size={12} className="text-muted-foreground/40" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
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
      <PanelMenu />

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
