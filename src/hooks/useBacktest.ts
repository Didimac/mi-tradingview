"use client";

import { useState, useCallback } from "react";
import {
  type BacktestConfig,
  type BacktestResult,
  type StrategyName,
  DEFAULT_PARAMS,
  loadCandles,
  runBacktest,
} from "@/lib/backtest/backtest-engine";
import { calculateMetrics, type BacktestMetrics } from "@/lib/backtest/metrics";
import type { Timeframe } from "@/lib/binance/types";

export interface UseBacktestReturn {
  /** Current configuration (editable) */
  config: BacktestConfig;
  /** Update config fields */
  setConfig: (patch: Partial<BacktestConfig>) => void;
  /** Change strategy (also resets params to defaults) */
  setStrategy: (name: StrategyName) => void;
  /** Run the backtest */
  run: () => Promise<void>;
  /** Whether currently running */
  loading: boolean;
  /** Error message if failed */
  error: string | null;
  /** Results from the last run */
  result: BacktestResult | null;
  /** Calculated metrics from the last run */
  metrics: BacktestMetrics | null;
}

const initialConfig: BacktestConfig = {
  symbol: "BTCUSDT",
  timeframe: "1h" as Timeframe,
  startEquity: 10000,
  strategy: "ema_cross",
  params: { ...DEFAULT_PARAMS.ema_cross },
  stopLossPct: 0,
  takeProfitPct: 0,
  candleCount: 2000,
};

export function useBacktest(): UseBacktestReturn {
  const [config, setConfigState] = useState<BacktestConfig>(initialConfig);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [metrics, setMetrics] = useState<BacktestMetrics | null>(null);

  const setConfig = useCallback((patch: Partial<BacktestConfig>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const setStrategy = useCallback((name: StrategyName) => {
    setConfigState((prev) => ({
      ...prev,
      strategy: name,
      params: { ...DEFAULT_PARAMS[name] },
      // Crypto Pulse strategies have preferred timeframes
      ...(name === "crypto_pulse" ? { timeframe: "4h" as Timeframe } : {}),
      ...(name === "crypto_pulse_v2" ? { timeframe: "1d" as Timeframe } : {}),
      ...(name === "pulse_scalper_1h" ? { timeframe: "1h" as Timeframe, candleCount: 2000, symbol: "LINKUSDT" } : {}),
    }));
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setMetrics(null);

    try {
      // 1. Load candles
      const candles = await loadCandles(
        config.symbol,
        config.timeframe,
        config.candleCount,
      );

      if (candles.length < 100) {
        throw new Error(
          `Solo se obtuvieron ${candles.length} velas. Se necesitan al menos 100.`,
        );
      }

      // 2. Run backtest
      const btResult = runBacktest(candles, config);

      // 3. Calculate metrics
      const btMetrics = calculateMetrics(btResult);

      setResult(btResult);
      setMetrics(btMetrics);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [config]);

  return {
    config,
    setConfig,
    setStrategy,
    run,
    loading,
    error,
    result,
    metrics,
  };
}
