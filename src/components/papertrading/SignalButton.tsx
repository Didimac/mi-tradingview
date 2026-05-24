"use client";

import { useEffect, useState, useCallback } from "react";
import { usePaperTrading } from "@/lib/papertrading/paperTradingEngine";
import { useChartStore } from "@/lib/store/chart-store";
import { fetchKlines } from "@/lib/binance/rest";
import type { Candle } from "@/lib/binance/types";
import { Zap } from "lucide-react";

// -----------------------------------------------------------------
// Inline Crypto Pulse v2 signal detector (lightweight, no full engine)
// -----------------------------------------------------------------

function calcEMA(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRSI(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  out[period] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
  }
  return out;
}

function calcATR(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close),
  ));
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

interface SignalInfo {
  signal: "LONG" | "SHORT";
  entry: number;
  sl: number;
  tp: number;
  reason: string;
}

function detectSignal(candles: Candle[]): SignalInfo | null {
  if (candles.length < 60) return null;

  const ef = calcEMA(candles, 21);
  const es = calcEMA(candles, 55);
  const rsiArr = calcRSI(candles, 14);
  const atr = calcATR(candles, 14);

  const i = candles.length - 1;
  const efV = ef[i], esV = es[i], rsi = rsiArr[i], rsiP = rsiArr[i - 1], atrV = atr[i];

  if ([efV, esV, rsi, rsiP, atrV].some(isNaN) || atrV === 0) return null;

  const c = candles[i];
  const sep = Math.abs(efV - esV) / esV * 100;
  if (sep < 0.3) return null;

  const slDist = atrV * 1.8;
  const tpDist = atrV * 3.6;

  // LONG trend
  if (efV > esV && rsiP < 45 && rsi >= 45 && c.close > efV) {
    return {
      signal: "LONG",
      entry: c.close,
      sl: c.close - slDist,
      tp: c.close + tpDist,
      reason: `Crypto Pulse v2 TREND LONG | RSI ${rsiP.toFixed(0)}->${rsi.toFixed(0)}`,
    };
  }
  // SHORT trend
  if (efV < esV && rsiP > 55 && rsi <= 55 && c.close < efV) {
    return {
      signal: "SHORT",
      entry: c.close,
      sl: c.close + slDist,
      tp: c.close - tpDist,
      reason: `Crypto Pulse v2 TREND SHORT | RSI ${rsiP.toFixed(0)}->${rsi.toFixed(0)}`,
    };
  }

  return null;
}

// -----------------------------------------------------------------
// Component
// -----------------------------------------------------------------

const TRACKED_PAIRS = ["LINKUSDT", "SOLUSDT"];

export function SignalButton() {
  const symbol = useChartStore((s) => s.symbol);
  const position = usePaperTrading((s) => s.position);
  const openTrade = usePaperTrading((s) => s.openTrade);
  const addToast = usePaperTrading((s) => s.addToast);

  const [signal, setSignal] = useState<SignalInfo | null>(null);
  const [checking, setChecking] = useState(false);

  const isTracked = TRACKED_PAIRS.includes(symbol);

  const checkSignal = useCallback(async () => {
    if (!isTracked || position) return;
    setChecking(true);
    try {
      const candles = await fetchKlines(symbol, "1h", 200);
      const sig = detectSignal(candles);
      setSignal(sig);
      if (sig) {
        addToast("signal", `Senal ${sig.signal} detectada en ${symbol}`);
      }
    } catch {
      // ignore
    }
    setChecking(false);
  }, [symbol, isTracked, position, addToast]);

  // Check on mount and every 5 minutes
  useEffect(() => {
    if (!isTracked) { setSignal(null); return; }
    checkSignal();
    const id = setInterval(checkSignal, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [isTracked, checkSignal]);

  // Reset signal when symbol changes
  useEffect(() => { setSignal(null); }, [symbol]);

  if (!isTracked) return null;

  const handleSimulate = () => {
    if (!signal) return;
    openTrade({
      symbol,
      side: signal.signal === "LONG" ? "long" : "short",
      price: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      reason: signal.reason,
    });
    setSignal(null);
  };

  if (position) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        Posicion abierta
      </div>
    );
  }

  if (signal) {
    return (
      <button
        onClick={handleSimulate}
        className={`flex items-center gap-1.5 h-8 px-4 rounded text-xs font-bold transition hover:opacity-90 ${
          signal.signal === "LONG"
            ? "bg-bull text-white"
            : "bg-bear text-white"
        }`}
      >
        <Zap size={12} />
        Simular {signal.signal} {symbol.replace("USDT", "")}
      </button>
    );
  }

  return (
    <button
      onClick={checkSignal}
      disabled={checking}
      className="flex items-center gap-1.5 h-8 px-3 rounded bg-panel border border-border/40 text-xs text-muted-foreground hover:text-foreground transition disabled:opacity-50"
    >
      <Zap size={12} />
      {checking ? "Buscando..." : `Buscar senal ${symbol.replace("USDT", "")}`}
    </button>
  );
}
