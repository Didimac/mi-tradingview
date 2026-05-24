"use client";

import {
  MousePointer2, TrendingUp, Minus, Ruler, Type, Shapes,
  Pencil, Eraser, Magnet, Lock, Eye, Trash2, ZoomIn,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChartStore, type DrawingTool } from "@/lib/store/chart-store";
import { cn } from "@/lib/utils";

interface ToolDef {
  key: DrawingTool;
  icon: typeof MousePointer2;
  label: string;
  hint?: string;
}

const TOOLS: ToolDef[] = [
  { key: "cursor", icon: MousePointer2, label: "Cursor", hint: "Modo navegación" },
  {
    key: "hline",
    icon: Minus,
    label: "Línea horizontal",
    hint: "Click en el chart para marcar un precio",
  },
  {
    key: "measure",
    icon: Ruler,
    label: "Regla / Medir",
    hint: "Click en dos puntos para medir Δ precio, %, barras y volumen",
  },
];

const LOCKED_TOOLS = [
  { icon: TrendingUp, label: "Línea de tendencia" },
  { icon: Shapes, label: "Patrones" },
  { icon: Pencil, label: "Dibujo libre" },
  { icon: Type, label: "Texto" },
  { icon: ZoomIn, label: "Zoom" },
  { icon: Magnet, label: "Imán" },
];

const FOOTER_TOOLS = [
  { icon: Lock, label: "Bloquear" },
  { icon: Eye, label: "Ocultar" },
  { icon: Eraser, label: "Borrar" },
];

export function LeftSidebar() {
  const tool = useChartStore((s) => s.tool);
  const setTool = useChartStore((s) => s.setTool);
  const clearPriceLines = useChartStore((s) => s.clearPriceLines);
  const symbol = useChartStore((s) => s.symbol);

  return (
    <aside className="w-11 bg-panel border-r border-border flex flex-col items-center py-1.5 shrink-0">
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = tool === t.key;
        return (
          <Tooltip key={t.key}>
            <TooltipTrigger
              onClick={() => setTool(t.key)}
              aria-label={t.label}
              className={cn(
                "w-8 h-8 my-0.5 rounded flex items-center justify-center transition",
                active
                  ? "bg-accent text-primary"
                  : "text-muted-foreground hover:bg-panel-hover hover:text-foreground",
              )}
            >
              <Icon className="w-[18px] h-[18px]" strokeWidth={1.6} />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <div className="font-medium">{t.label}</div>
              {t.hint && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">{t.hint}</div>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}

      <Tooltip>
        <TooltipTrigger
          onClick={() => clearPriceLines(symbol)}
          aria-label="Eliminar todo"
          className="w-8 h-8 my-0.5 rounded flex items-center justify-center text-muted-foreground hover:bg-panel-hover hover:text-bear transition"
        >
          <Trash2 className="w-[18px] h-[18px]" strokeWidth={1.6} />
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div className="font-medium">Eliminar dibujos</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Limpia las líneas de este símbolo
          </div>
        </TooltipContent>
      </Tooltip>

      <div className="my-1 h-px w-6 bg-border" />

      {LOCKED_TOOLS.map((t) => {
        const Icon = t.icon;
        return (
          <Tooltip key={t.label}>
            <TooltipTrigger
              disabled
              aria-label={t.label}
              className="w-8 h-8 my-0.5 rounded flex items-center justify-center text-muted-foreground opacity-40 cursor-not-allowed"
            >
              <Icon className="w-[18px] h-[18px]" strokeWidth={1.6} />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <div className="font-medium">{t.label}</div>
              <div className="mt-0.5 text-[10px] text-yellow-400">Próximamente</div>
            </TooltipContent>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      {FOOTER_TOOLS.map((t) => {
        const Icon = t.icon;
        return (
          <button
            key={t.label}
            title={t.label}
            className="w-8 h-8 my-0.5 rounded flex items-center justify-center text-muted-foreground hover:bg-panel-hover hover:text-foreground transition"
          >
            <Icon className="w-[18px] h-[18px]" strokeWidth={1.6} />
          </button>
        );
      })}
    </aside>
  );
}
