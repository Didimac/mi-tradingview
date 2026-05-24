"use client";

import { useBacktest } from "@/hooks/useBacktest";
import type { StrategyName, StrategyParams } from "@/lib/backtest/backtest-engine";
import { DEFAULT_PARAMS } from "@/lib/backtest/backtest-engine";
import type { Timeframe } from "@/lib/binance/types";
import { formatPrice, formatPct, formatVolume } from "@/lib/format";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
} from "recharts";
import {
  Play,
  Loader2,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Target,
  Shield,
  Zap,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";

/* ------------------------------------------------------------------ */
/*  Strategy labels and timeframe options                              */
/* ------------------------------------------------------------------ */

const STRATEGY_OPTIONS: { value: StrategyName; label: string; desc: string }[] = [
  { value: "ema_cross", label: "EMA Cruce", desc: "Cruce de dos medias exponenciales" },
  { value: "rsi_ob_os", label: "RSI Sobre/Sub", desc: "RSI sobrecompra y sobreventa" },
  { value: "macd_cross", label: "MACD Cruce", desc: "Cruce de MACD y linea de senal" },
  { value: "triple_ema", label: "Triple EMA", desc: "Alineacion de tres EMAs" },
  { value: "crypto_pulse", label: "Crypto Pulse (hibrido 4H)", desc: "Tendencia + rebote con ATR, trailing stop y regimen adaptativo" },
  { value: "crypto_pulse_v2", label: "Crypto Pulse v2 (1D)", desc: "v2: ADX filter, RSI ampliado, trailing mejorado, slippage+comision" },
  { value: "pulse_scalper_1h", label: "Pulse Scalper 1H", desc: "Scalper intradía: EMA8/21, RSI9, VWAP, filtro sesion, timeout 8 bars" },
];

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "2h", label: "2h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("es-ES", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MetricCard({
  label,
  value,
  color,
  icon: Icon,
}: {
  label: string;
  value: string;
  color?: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="rounded-lg bg-panel/60 border border-border/40 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        {Icon && <Icon size={12} />}
        {label}
      </div>
      <div className={`text-sm font-mono font-semibold ${color ?? "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Strategy params editors                                            */
/* ------------------------------------------------------------------ */

function ParamInput({
  label,
  value,
  onChange,
  min = 1,
  max = 500,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded bg-background border border-border/60 px-2 py-1.5 text-sm text-foreground font-mono w-full focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function StrategyParamsEditor({
  strategy,
  params,
  onChange,
}: {
  strategy: StrategyName;
  params: StrategyParams[StrategyName];
  onChange: (p: StrategyParams[StrategyName]) => void;
}) {
  switch (strategy) {
    case "ema_cross": {
      const p = params as StrategyParams["ema_cross"];
      return (
        <div className="grid grid-cols-2 gap-3">
          <ParamInput label="EMA Rapida" value={p.fastPeriod} onChange={(v) => onChange({ ...p, fastPeriod: v })} />
          <ParamInput label="EMA Lenta" value={p.slowPeriod} onChange={(v) => onChange({ ...p, slowPeriod: v })} />
        </div>
      );
    }
    case "rsi_ob_os": {
      const p = params as StrategyParams["rsi_ob_os"];
      return (
        <div className="grid grid-cols-3 gap-3">
          <ParamInput label="Periodo" value={p.period} onChange={(v) => onChange({ ...p, period: v })} />
          <ParamInput label="Sobrecompra" value={p.overbought} min={50} max={100} onChange={(v) => onChange({ ...p, overbought: v })} />
          <ParamInput label="Sobreventa" value={p.oversold} min={0} max={50} onChange={(v) => onChange({ ...p, oversold: v })} />
        </div>
      );
    }
    case "macd_cross": {
      const p = params as StrategyParams["macd_cross"];
      return (
        <div className="grid grid-cols-3 gap-3">
          <ParamInput label="Rapido" value={p.fast} onChange={(v) => onChange({ ...p, fast: v })} />
          <ParamInput label="Lento" value={p.slow} onChange={(v) => onChange({ ...p, slow: v })} />
          <ParamInput label="Senal" value={p.signal} onChange={(v) => onChange({ ...p, signal: v })} />
        </div>
      );
    }
    case "triple_ema": {
      const p = params as StrategyParams["triple_ema"];
      return (
        <div className="grid grid-cols-3 gap-3">
          <ParamInput label="Rapida" value={p.fast} onChange={(v) => onChange({ ...p, fast: v })} />
          <ParamInput label="Media" value={p.mid} onChange={(v) => onChange({ ...p, mid: v })} />
          <ParamInput label="Lenta" value={p.slow} onChange={(v) => onChange({ ...p, slow: v })} />
        </div>
      );
    }
    case "crypto_pulse": {
      const p = params as StrategyParams["crypto_pulse"];
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="EMA Rapida" value={p.emaFast} onChange={(v) => onChange({ ...p, emaFast: v })} />
            <ParamInput label="EMA Lenta" value={p.emaSlow} onChange={(v) => onChange({ ...p, emaSlow: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ParamInput label="RSI Periodo" value={p.rsiPeriod} onChange={(v) => onChange({ ...p, rsiPeriod: v })} />
            <ParamInput label="ATR Periodo" value={p.atrPeriod} onChange={(v) => onChange({ ...p, atrPeriod: v })} />
            <ParamInput label="Trend Sep %" value={p.trendSeparationPct} min={0.1} max={5} step={0.1} onChange={(v) => onChange({ ...p, trendSeparationPct: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="ATR SL Mult" value={p.atrSlMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => onChange({ ...p, atrSlMultiplier: v })} />
            <ParamInput label="ATR TP Mult" value={p.atrTpMultiplier} min={1} max={10} step={0.5} onChange={(v) => onChange({ ...p, atrTpMultiplier: v })} />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            SL/TP basados en ATR · Trailing stop a breakeven incluido
          </p>
        </div>
      );
    }
    case "crypto_pulse_v2": {
      const p = params as StrategyParams["crypto_pulse_v2"];
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="EMA Rapida" value={p.emaFast} onChange={(v) => onChange({ ...p, emaFast: v })} />
            <ParamInput label="EMA Lenta" value={p.emaSlow} onChange={(v) => onChange({ ...p, emaSlow: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ParamInput label="RSI Periodo" value={p.rsiPeriod} onChange={(v) => onChange({ ...p, rsiPeriod: v })} />
            <ParamInput label="ATR Periodo" value={p.atrPeriod} onChange={(v) => onChange({ ...p, atrPeriod: v })} />
            <ParamInput label="ADX Periodo" value={p.adxPeriod} onChange={(v) => onChange({ ...p, adxPeriod: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ParamInput label="ADX Min" value={p.adxTrendMin} min={10} max={40} onChange={(v) => onChange({ ...p, adxTrendMin: v })} />
            <ParamInput label="ATR SL x" value={p.atrSlMult} min={0.5} max={5} step={0.1} onChange={(v) => onChange({ ...p, atrSlMult: v })} />
            <ParamInput label="ATR TP x" value={p.atrTpMult} min={1} max={10} step={0.1} onChange={(v) => onChange({ ...p, atrTpMult: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="Trail Activ (xATR)" value={p.trailingActivation} min={0.5} max={3} step={0.1} onChange={(v) => onChange({ ...p, trailingActivation: v })} />
            <ParamInput label="Trail SL (xATR)" value={p.trailingNewSL} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...p, trailingNewSL: v })} />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            v2: ADX &gt; {p.adxTrendMin} en TREND · SL/TP ATR · Trailing a entry+{p.trailingNewSL}xATR · Comision {(p.commissionPct * 100).toFixed(1)}% · Slippage {(p.slippagePct * 100).toFixed(2)}%
          </p>
        </div>
      );
    }
    case "pulse_scalper_1h": {
      const p = params as StrategyParams["pulse_scalper_1h"];
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="EMA Rapida" value={p.emaFast} onChange={(v) => onChange({ ...p, emaFast: v })} />
            <ParamInput label="EMA Lenta" value={p.emaSlow} onChange={(v) => onChange({ ...p, emaSlow: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ParamInput label="RSI Periodo" value={p.rsiPeriod} onChange={(v) => onChange({ ...p, rsiPeriod: v })} />
            <ParamInput label="ATR Periodo" value={p.atrPeriod} onChange={(v) => onChange({ ...p, atrPeriod: v })} />
            <ParamInput label="Timeout (bars)" value={p.maxBarsInTrade} min={3} max={20} onChange={(v) => onChange({ ...p, maxBarsInTrade: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="ATR SL x" value={p.atrSlMult} min={0.5} max={3} step={0.1} onChange={(v) => onChange({ ...p, atrSlMult: v })} />
            <ParamInput label="ATR TP x" value={p.atrTpMult} min={1} max={6} step={0.1} onChange={(v) => onChange({ ...p, atrTpMult: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="Trail Activ (xATR)" value={p.trailingActivation} min={0.3} max={3} step={0.1} onChange={(v) => onChange({ ...p, trailingActivation: v })} />
            <ParamInput label="Trail SL (xATR)" value={p.trailingNewSL} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...p, trailingNewSL: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput label="ATR Vol Lookback" value={p.atrSmaLookback} min={5} max={50} onChange={(v) => onChange({ ...p, atrSmaLookback: v })} />
            <ParamInput label="ATR Vol Min x" value={p.atrVolMinMult} min={0.3} max={1.5} step={0.05} onChange={(v) => onChange({ ...p, atrVolMinMult: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ParamInput label="Riesgo %" value={p.riskPerTrade * 100} min={0.1} max={5} step={0.1} onChange={(v) => onChange({ ...p, riskPerTrade: v / 100 })} />
            <ParamInput label="Max trades/dia" value={p.maxTradesPerDay} min={1} max={10} onChange={(v) => onChange({ ...p, maxTradesPerDay: v })} />
            <ParamInput label="Circuit Break %" value={p.circuitBreakerPct * 100} min={1} max={10} step={0.5} onChange={(v) => onChange({ ...p, circuitBreakerPct: v / 100 })} />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            EMA8x21 + RSI9 + VWAP soft + ATR vol filter · Sesiones 01-21h UTC · SL {p.atrSlMult}x / TP {p.atrTpMult}x ATR · Timeout {p.maxBarsInTrade} bars · Max {p.maxTradesPerDay} trades/dia · CB {(p.circuitBreakerPct * 100).toFixed(0)}%
          </p>
        </div>
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function BacktestPanel() {
  const {
    config,
    setConfig,
    setStrategy,
    run,
    loading,
    error,
    result,
    metrics,
  } = useBacktest();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/40 bg-panel/80 backdrop-blur-sm px-4 h-12">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm"
        >
          <ArrowLeft size={16} />
          Chart
        </Link>
        <div className="h-4 w-px bg-border/60" />
        <BarChart3 size={18} className="text-primary" />
        <h1 className="text-sm font-semibold">Backtesting</h1>
      </header>

      <div className="max-w-7xl mx-auto p-4 space-y-6">
        {/* ---- Configuration ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Symbol & Timeframe */}
          <div className="rounded-xl bg-panel/40 border border-border/30 p-4 space-y-4">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Mercado
            </h2>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Simbolo
              <input
                type="text"
                value={config.symbol}
                onChange={(e) => setConfig({ symbol: e.target.value.toUpperCase() })}
                className="rounded bg-background border border-border/60 px-2 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            {config.strategy === "pulse_scalper_1h" && (
              <div className="space-y-1.5">
                <span className="text-[10px] text-muted-foreground/70">Pares recomendados:</span>
                <div className="flex flex-wrap gap-1.5">
                  {["LINKUSDT", "AVAXUSDT", "SOLUSDT", "XRPUSDT"].map((p) => (
                    <button
                      key={p}
                      onClick={() => setConfig({ symbol: p })}
                      className={`text-[11px] px-2 py-0.5 rounded-md border transition-colors ${
                        config.symbol === p
                          ? "bg-primary/15 border-primary/50 text-primary font-medium"
                          : "bg-background/50 border-border/40 text-muted-foreground hover:border-border/70"
                      }`}
                    >
                      {p.replace("USDT", "")}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Temporalidad
              <select
                value={config.timeframe}
                onChange={(e) => setConfig({ timeframe: e.target.value as Timeframe })}
                className="rounded bg-background border border-border/60 px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf.value} value={tf.value}>
                    {tf.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <ParamInput
                label="Capital Inicial (USDT)"
                value={config.startEquity}
                min={100}
                max={1000000}
                step={100}
                onChange={(v) => setConfig({ startEquity: v })}
              />
              <ParamInput
                label="Velas"
                value={config.candleCount}
                min={200}
                max={3000}
                step={100}
                onChange={(v) => setConfig({ candleCount: v })}
              />
            </div>
          </div>

          {/* Strategy */}
          <div className="rounded-xl bg-panel/40 border border-border/30 p-4 space-y-4">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Estrategia
            </h2>
            <div className="space-y-2">
              {STRATEGY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setStrategy(opt.value)}
                  className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors border ${
                    config.strategy === opt.value
                      ? "bg-primary/10 border-primary/40 text-primary"
                      : "bg-background/50 border-border/30 text-muted-foreground hover:text-foreground hover:border-border/60"
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs opacity-70">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Params + Risk */}
          <div className="rounded-xl bg-panel/40 border border-border/30 p-4 space-y-4">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Parametros
            </h2>
            <StrategyParamsEditor
              strategy={config.strategy}
              params={config.params}
              onChange={(p) => setConfig({ params: p })}
            />

            <div className="border-t border-border/30 pt-4">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Gestion de Riesgo
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <ParamInput
                  label="Stop-Loss %"
                  value={config.stopLossPct}
                  min={0}
                  max={50}
                  step={0.5}
                  onChange={(v) => setConfig({ stopLossPct: v })}
                />
                <ParamInput
                  label="Take-Profit %"
                  value={config.takeProfitPct}
                  min={0}
                  max={100}
                  step={0.5}
                  onChange={(v) => setConfig({ takeProfitPct: v })}
                />
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-2">
                0 = desactivado
              </p>
            </div>

            {/* Run Button */}
            <button
              onClick={run}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground font-semibold py-2.5 text-sm transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Ejecutando...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Ejecutar Backtest
                </>
              )}
            </button>

            {error && (
              <div className="rounded-lg bg-bear/10 border border-bear/30 p-3 text-xs text-bear">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* ---- Results ---- */}
        {metrics && result && (
          <>
            {/* Key metrics grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard
                label="Retorno Total"
                value={formatPct(metrics.totalReturn)}
                color={metrics.totalReturn >= 0 ? "text-bull" : "text-bear"}
                icon={metrics.totalReturn >= 0 ? TrendingUp : TrendingDown}
              />
              <MetricCard
                label="P&L (USDT)"
                value={formatPrice(metrics.totalPnl)}
                color={metrics.totalPnl >= 0 ? "text-bull" : "text-bear"}
                icon={Zap}
              />
              <MetricCard
                label="Win Rate"
                value={`${metrics.winRate.toFixed(1)}%`}
                color={metrics.winRate >= 50 ? "text-bull" : "text-bear"}
                icon={Target}
              />
              <MetricCard
                label="Profit Factor"
                value={metrics.profitFactor === Infinity ? "∞" : metrics.profitFactor.toFixed(2)}
                color={metrics.profitFactor >= 1 ? "text-bull" : "text-bear"}
              />
              <MetricCard
                label="Max Drawdown"
                value={`${metrics.maxDrawdown.toFixed(2)}%`}
                color="text-bear"
                icon={Shield}
              />
              <MetricCard
                label="Sharpe Ratio"
                value={metrics.sharpeRatio.toFixed(2)}
                color={metrics.sharpeRatio >= 1 ? "text-bull" : metrics.sharpeRatio >= 0 ? "text-foreground" : "text-bear"}
              />
            </div>

            {/* Detailed metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 text-xs">
              <MetricCard label="Total Trades" value={String(metrics.totalTrades)} />
              <MetricCard label="Ganadores" value={String(metrics.winningTrades)} color="text-bull" />
              <MetricCard label="Perdedores" value={String(metrics.losingTrades)} color="text-bear" />
              <MetricCard label="Avg Win" value={`${metrics.avgWin.toFixed(2)}%`} color="text-bull" />
              <MetricCard label="Avg Loss" value={`${metrics.avgLoss.toFixed(2)}%`} color="text-bear" />
              <MetricCard label="Expectancy" value={`$${metrics.expectancy.toFixed(2)}`} />
              <MetricCard label="Racha Wins" value={String(metrics.consecutiveWins)} color="text-bull" />
              <MetricCard label="Racha Losses" value={String(metrics.consecutiveLosses)} color="text-bear" />
            </div>

            {/* Equity curve */}
            <div className="rounded-xl bg-panel/40 border border-border/30 p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                Curva de Equity
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={result.equity}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(t: number) => formatDate(t)}
                    tick={{ fontSize: 10, fill: "#787b86" }}
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#787b86" }}
                    stroke="rgba(255,255,255,0.1)"
                    tickFormatter={(v: number) => `$${formatVolume(v)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "oklch(0.235 0.015 260)",
                      border: "1px solid oklch(0.35 0.01 260)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(t) => formatDate(Number(t))}
                    formatter={(v) => [`$${formatPrice(Number(v))}`, "Equity"]}
                  />
                  <ReferenceLine
                    y={config.startEquity}
                    stroke="#787b86"
                    strokeDasharray="3 3"
                  />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke="#2962ff"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Trade P&L distribution */}
            <div className="rounded-xl bg-panel/40 border border-border/30 p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                P&L por Trade
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={result.trades.map((t, i) => ({
                    index: i + 1,
                    pnl: t.pnl,
                    pnlPct: t.pnlPct,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    dataKey="index"
                    tick={{ fontSize: 10, fill: "#787b86" }}
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#787b86" }}
                    stroke="rgba(255,255,255,0.1)"
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "oklch(0.235 0.015 260)",
                      border: "1px solid oklch(0.35 0.01 260)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v, name) => {
                      const n = Number(v);
                      if (name === "pnl") return [`$${formatPrice(n)}`, "P&L"];
                      return [`${n.toFixed(2)}%`, "P&L %"];
                    }}
                  />
                  <ReferenceLine y={0} stroke="#787b86" />
                  <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                    {result.trades.map((t, i) => (
                      <Cell
                        key={i}
                        fill={t.pnl >= 0 ? "oklch(0.70 0.13 175)" : "oklch(0.68 0.20 25)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Trade log */}
            <div className="rounded-xl bg-panel/40 border border-border/30 p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                Historial de Trades ({result.trades.length})
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/30 text-muted-foreground">
                      <th className="py-2 px-2 text-left">#</th>
                      <th className="py-2 px-2 text-left">Lado</th>
                      <th className="py-2 px-2 text-right">Entrada</th>
                      <th className="py-2 px-2 text-right">Salida</th>
                      <th className="py-2 px-2 text-right">P&L</th>
                      <th className="py-2 px-2 text-right">P&L %</th>
                      <th className="py-2 px-2 text-left">Razon</th>
                      <th className="py-2 px-2 text-right">Barras</th>
                      <th className="py-2 px-2 text-left">Fecha Entrada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr
                        key={i}
                        className="border-b border-border/10 hover:bg-border/5 transition-colors"
                      >
                        <td className="py-1.5 px-2 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 px-2">
                          <span
                            className={`inline-flex items-center gap-1 font-semibold ${
                              t.side === "long" ? "text-bull" : "text-bear"
                            }`}
                          >
                            {t.side === "long" ? (
                              <TrendingUp size={10} />
                            ) : (
                              <TrendingDown size={10} />
                            )}
                            {t.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {formatPrice(t.entryPrice)}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {formatPrice(t.exitPrice)}
                        </td>
                        <td
                          className={`py-1.5 px-2 text-right font-mono font-semibold ${
                            t.pnl >= 0 ? "text-bull" : "text-bear"
                          }`}
                        >
                          {t.pnl >= 0 ? "+" : ""}
                          {formatPrice(t.pnl)}
                        </td>
                        <td
                          className={`py-1.5 px-2 text-right font-mono ${
                            t.pnlPct >= 0 ? "text-bull" : "text-bear"
                          }`}
                        >
                          {formatPct(t.pnlPct)}
                        </td>
                        <td className="py-1.5 px-2 text-muted-foreground max-w-[150px] truncate">
                          {t.reason}
                        </td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">
                          {t.bars}
                        </td>
                        <td className="py-1.5 px-2 text-muted-foreground">
                          {formatDate(t.entryTime)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* Empty state */}
        {!result && !loading && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/60">
            <BarChart3 size={48} strokeWidth={1} />
            <p className="mt-4 text-sm">
              Configura tu estrategia y ejecuta el backtest
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
