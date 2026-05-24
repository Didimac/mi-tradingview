"use client";

import { usePaperTrading, type Toast } from "@/lib/papertrading/paperTradingEngine";
import { X } from "lucide-react";

const COLORS: Record<Toast["type"], { bg: string; border: string; text: string }> = {
  signal: { bg: "bg-blue-950/90", border: "border-blue-500/40", text: "text-blue-300" },
  win: { bg: "bg-emerald-950/90", border: "border-emerald-500/40", text: "text-emerald-300" },
  loss: { bg: "bg-red-950/90", border: "border-red-500/40", text: "text-red-300" },
};

const LABELS: Record<Toast["type"], string> = {
  signal: "PAPER TRADE",
  win: "TRADE CERRADO",
  loss: "TRADE CERRADO",
};

export function ToastContainer() {
  const toasts = usePaperTrading((s) => s.toasts);
  const dismiss = usePaperTrading((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-auto">
      {toasts.map((t) => {
        const c = COLORS[t.type];
        return (
          <div
            key={t.id}
            className={`${c.bg} ${c.border} border rounded-lg px-4 py-3 shadow-2xl backdrop-blur-sm
              animate-in slide-in-from-right-5 fade-in duration-300 min-w-[280px] max-w-[380px]`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${c.text}`}>
                  {LABELS[t.type]}
                </span>
                <p className="text-xs text-foreground mt-0.5 font-mono">{t.message}</p>
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
