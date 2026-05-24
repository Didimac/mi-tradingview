"use client";

import { Search, ChevronDown, Bell, Camera, Save, Settings, BarChart3, LineChart } from "lucide-react";
import { SymbolSelector } from "@/components/chart/SymbolSelector";
import { TimeframeSelector } from "@/components/chart/TimeframeSelector";
import { IndicatorMenu } from "@/components/chart/IndicatorMenu";

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
