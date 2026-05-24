import type { Candle, Timeframe } from "@/lib/binance/types";
import { ema, rsi, macd } from "@/lib/indicators";
import { fetchKlines, fetchKlinesBefore } from "@/lib/binance/rest";
import {
  type CryptoPulseConfig,
  DEFAULT_CRYPTO_PULSE_CONFIG,
  precomputeIndicators,
  evaluateBar,
  checkPositionExit,
  type OpenPosition,
} from "@/lib/backtest/strategies/cryptoPulse";
import {
  type CryptoPulseV2Config,
  DEFAULT_V2_CONFIG,
  precomputeV2,
  evaluateBarV2,
  checkExitV2,
  calcPositionV2,
  type OpenPositionV2,
} from "@/lib/backtest/strategies/cryptoPulseV2";
import {
  type PulseScalperConfig,
  DEFAULT_SCALPER_CONFIG,
  precomputeScalper,
  evaluateBarScalper,
  checkExitScalper,
  calcPositionScalper,
  type ScalperOpenPosition,
} from "@/lib/backtest/strategies/pulseScalper1H";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SignalSide = "long" | "short";
export type SignalAction = "entry" | "exit";

export interface Signal {
  index: number;
  time: number;
  side: SignalSide;
  action: SignalAction;
  price: number;
  reason: string;
}

export interface Trade {
  entryIndex: number;
  exitIndex: number;
  entryTime: number;
  exitTime: number;
  side: SignalSide;
  entryPrice: number;
  exitPrice: number;
  pnl: number;        // absolute USDT P&L
  pnlPct: number;     // percentage return
  reason: string;
  bars: number;        // duration in bars
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;    // % drawdown from peak at this point
}

export interface BacktestResult {
  trades: Trade[];
  equity: EquityPoint[];
  signals: Signal[];
  candles: Candle[];
  finalEquity: number;
  startEquity: number;
}

/* ------------------------------------------------------------------ */
/*  Strategy configuration                                             */
/* ------------------------------------------------------------------ */

export type StrategyName = "ema_cross" | "rsi_ob_os" | "macd_cross" | "triple_ema" | "crypto_pulse" | "crypto_pulse_v2" | "pulse_scalper_1h";

export interface StrategyParams {
  ema_cross: { fastPeriod: number; slowPeriod: number };
  rsi_ob_os: { period: number; overbought: number; oversold: number };
  macd_cross: { fast: number; slow: number; signal: number };
  triple_ema: { fast: number; mid: number; slow: number };
  crypto_pulse: CryptoPulseConfig;
  crypto_pulse_v2: CryptoPulseV2Config;
  pulse_scalper_1h: PulseScalperConfig;
}

export interface BacktestConfig<S extends StrategyName = StrategyName> {
  symbol: string;
  timeframe: Timeframe;
  startEquity: number;
  strategy: S;
  params: StrategyParams[S];
  /** 0-100; 0 = no stop-loss */
  stopLossPct: number;
  /** 0-100; 0 = no take-profit */
  takeProfitPct: number;
  /** How many candles to load (max ~3000 via multiple fetches) */
  candleCount: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  ema_cross: { fastPeriod: 20, slowPeriod: 50 },
  rsi_ob_os: { period: 14, overbought: 70, oversold: 30 },
  macd_cross: { fast: 12, slow: 26, signal: 9 },
  triple_ema: { fast: 10, mid: 21, slow: 55 },
  crypto_pulse: { ...DEFAULT_CRYPTO_PULSE_CONFIG },
  crypto_pulse_v2: { ...DEFAULT_V2_CONFIG },
  pulse_scalper_1h: { ...DEFAULT_SCALPER_CONFIG },
};

/* ------------------------------------------------------------------ */
/*  Data loading — fetches up to `count` candles                       */
/* ------------------------------------------------------------------ */

export async function loadCandles(
  symbol: string,
  timeframe: Timeframe,
  count: number,
): Promise<Candle[]> {
  // First batch (most recent 1000)
  let candles = await fetchKlines(symbol, timeframe, Math.min(count, 1000));
  while (candles.length < count) {
    const oldest = candles[0];
    const batch = await fetchKlinesBefore(
      symbol,
      timeframe,
      oldest.time * 1000,
      Math.min(count - candles.length, 1000),
    );
    if (batch.length === 0) break;
    candles = [...batch, ...candles];
  }
  // Sort ascending by time and deduplicate
  const seen = new Set<number>();
  candles = candles
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });
  return candles;
}

/* ------------------------------------------------------------------ */
/*  Strategy signal generators                                         */
/* ------------------------------------------------------------------ */

function emaCrossSignals(
  candles: Candle[],
  params: StrategyParams["ema_cross"],
): Signal[] {
  const fastLine = ema(candles, params.fastPeriod);
  const slowLine = ema(candles, params.slowPeriod);

  // Align by time
  const slowByTime = new Map(slowLine.map((p) => [p.time, p.value]));
  const aligned: { time: number; fast: number; slow: number; idx: number }[] = [];
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));

  for (const fp of fastLine) {
    const sv = slowByTime.get(fp.time);
    const idx = timeToIdx.get(fp.time);
    if (sv !== undefined && idx !== undefined) {
      aligned.push({ time: fp.time, fast: fp.value, slow: sv, idx });
    }
  }

  const signals: Signal[] = [];
  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1];
    const curr = aligned[i];
    // Golden cross: fast crosses above slow
    if (prev.fast <= prev.slow && curr.fast > curr.slow) {
      signals.push({
        index: curr.idx,
        time: curr.time,
        side: "long",
        action: "entry",
        price: candles[curr.idx].close,
        reason: "EMA golden cross",
      });
    }
    // Death cross: fast crosses below slow
    if (prev.fast >= prev.slow && curr.fast < curr.slow) {
      signals.push({
        index: curr.idx,
        time: curr.time,
        side: "short",
        action: "entry",
        price: candles[curr.idx].close,
        reason: "EMA death cross",
      });
    }
  }
  return signals;
}

function rsiSignals(
  candles: Candle[],
  params: StrategyParams["rsi_ob_os"],
): Signal[] {
  const rsiLine = rsi(candles, params.period);
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
  const signals: Signal[] = [];

  for (let i = 1; i < rsiLine.length; i++) {
    const prev = rsiLine[i - 1];
    const curr = rsiLine[i];
    const idx = timeToIdx.get(curr.time);
    if (idx === undefined) continue;

    // RSI crosses above oversold → long entry
    if (prev.value <= params.oversold && curr.value > params.oversold) {
      signals.push({
        index: idx,
        time: curr.time,
        side: "long",
        action: "entry",
        price: candles[idx].close,
        reason: `RSI crossed above ${params.oversold}`,
      });
    }
    // RSI crosses below overbought → short entry
    if (prev.value >= params.overbought && curr.value < params.overbought) {
      signals.push({
        index: idx,
        time: curr.time,
        side: "short",
        action: "entry",
        price: candles[idx].close,
        reason: `RSI crossed below ${params.overbought}`,
      });
    }
  }
  return signals;
}

function macdCrossSignals(
  candles: Candle[],
  params: StrategyParams["macd_cross"],
): Signal[] {
  const macdLine = macd(candles, params.fast, params.slow, params.signal);
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
  const signals: Signal[] = [];

  for (let i = 1; i < macdLine.length; i++) {
    const prev = macdLine[i - 1];
    const curr = macdLine[i];
    const idx = timeToIdx.get(curr.time);
    if (idx === undefined) continue;

    // MACD crosses above signal → long
    if (prev.macd <= prev.signal && curr.macd > curr.signal) {
      signals.push({
        index: idx,
        time: curr.time,
        side: "long",
        action: "entry",
        price: candles[idx].close,
        reason: "MACD bullish cross",
      });
    }
    // MACD crosses below signal → short
    if (prev.macd >= prev.signal && curr.macd < curr.signal) {
      signals.push({
        index: idx,
        time: curr.time,
        side: "short",
        action: "entry",
        price: candles[idx].close,
        reason: "MACD bearish cross",
      });
    }
  }
  return signals;
}

function tripleEmaSignals(
  candles: Candle[],
  params: StrategyParams["triple_ema"],
): Signal[] {
  const fastLine = ema(candles, params.fast);
  const midLine = ema(candles, params.mid);
  const slowLine = ema(candles, params.slow);

  const midByTime = new Map(midLine.map((p) => [p.time, p.value]));
  const slowByTime = new Map(slowLine.map((p) => [p.time, p.value]));
  const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));

  const aligned: { time: number; f: number; m: number; s: number; idx: number }[] = [];
  for (const fp of fastLine) {
    const mv = midByTime.get(fp.time);
    const sv = slowByTime.get(fp.time);
    const idx = timeToIdx.get(fp.time);
    if (mv !== undefined && sv !== undefined && idx !== undefined) {
      aligned.push({ time: fp.time, f: fp.value, m: mv, s: sv, idx });
    }
  }

  const signals: Signal[] = [];
  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1];
    const curr = aligned[i];
    // All three aligned bullish: fast > mid > slow (wasn't before)
    const prevBull = prev.f > prev.m && prev.m > prev.s;
    const currBull = curr.f > curr.m && curr.m > curr.s;
    if (!prevBull && currBull) {
      signals.push({
        index: curr.idx,
        time: curr.time,
        side: "long",
        action: "entry",
        price: candles[curr.idx].close,
        reason: "Triple EMA aligned bullish",
      });
    }
    // All three aligned bearish: fast < mid < slow
    const prevBear = prev.f < prev.m && prev.m < prev.s;
    const currBear = curr.f < curr.m && curr.m < curr.s;
    if (!prevBear && currBear) {
      signals.push({
        index: curr.idx,
        time: curr.time,
        side: "short",
        action: "entry",
        price: candles[curr.idx].close,
        reason: "Triple EMA aligned bearish",
      });
    }
  }
  return signals;
}

function getSignals(
  candles: Candle[],
  strategy: StrategyName,
  params: StrategyParams[StrategyName],
): Signal[] {
  switch (strategy) {
    case "ema_cross":
      return emaCrossSignals(candles, params as StrategyParams["ema_cross"]);
    case "rsi_ob_os":
      return rsiSignals(candles, params as StrategyParams["rsi_ob_os"]);
    case "macd_cross":
      return macdCrossSignals(candles, params as StrategyParams["macd_cross"]);
    case "triple_ema":
      return tripleEmaSignals(candles, params as StrategyParams["triple_ema"]);
    case "crypto_pulse":
      // Crypto Pulse uses its own candle-by-candle loop (runCryptoPulse)
      return [];
    case "crypto_pulse_v2":
      // Crypto Pulse v2 uses its own candle-by-candle loop (runCryptoPulseV2)
      return [];
    case "pulse_scalper_1h":
      // Pulse Scalper 1H uses its own candle-by-candle loop (runPulseScalper1H)
      return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Backtest engine                                                    */
/* ------------------------------------------------------------------ */

export function runBacktest(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  // Crypto Pulse strategies have their own dedicated runners
  if (config.strategy === "crypto_pulse") {
    return runCryptoPulse(candles, config);
  }
  if (config.strategy === "crypto_pulse_v2") {
    return runCryptoPulseV2(candles, config);
  }
  if (config.strategy === "pulse_scalper_1h") {
    return runPulseScalper1H(candles, config);
  }

  const signals = getSignals(candles, config.strategy, config.params);
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];

  let cash = config.startEquity;
  let peak = cash;
  let position: { side: SignalSide; entryPrice: number; entryIndex: number; entryTime: number } | null = null;

  // Process signals in order
  for (const sig of signals) {
    // If we have a position, check if this signal closes it
    if (position) {
      const isOppositeEntry = sig.action === "entry" && sig.side !== position.side;
      const isSameSideExit = sig.action === "exit" && sig.side === position.side;

      if (isOppositeEntry || isSameSideExit) {
        // Close position
        const exitPrice = sig.price;
        let pnl: number;
        if (position.side === "long") {
          pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
        } else {
          pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
        }
        const pnlPct = (pnl / cash) * 100;
        cash += pnl;

        trades.push({
          entryIndex: position.entryIndex,
          exitIndex: sig.index,
          entryTime: position.entryTime,
          exitTime: sig.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl,
          pnlPct,
          reason: sig.reason,
          bars: sig.index - position.entryIndex,
        });

        if (cash > peak) peak = cash;
        equity.push({
          time: sig.time,
          equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });

        position = null;

        // If this was an opposite entry, open new position
        if (isOppositeEntry) {
          position = {
            side: sig.side,
            entryPrice: sig.price,
            entryIndex: sig.index,
            entryTime: sig.time,
          };
        }
      }
    } else if (sig.action === "entry") {
      // Open new position
      position = {
        side: sig.side,
        entryPrice: sig.price,
        entryIndex: sig.index,
        entryTime: sig.time,
      };
      equity.push({
        time: sig.time,
        equity: cash,
        drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
      });
    }

    // Check stop-loss and take-profit on each candle after entry
    if (position && config.stopLossPct > 0) {
      // Scan candles between current signal and next for SL/TP
    }
  }

  // Also scan every candle for SL/TP while in position
  if (config.stopLossPct > 0 || config.takeProfitPct > 0) {
    const result = runWithStopLoss(candles, config);
    return result;
  }

  // Close any remaining position at last candle
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.close;
    let pnl: number;
    if (position.side === "long") {
      pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
    } else {
      pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
    }
    cash += pnl;
    trades.push({
      entryIndex: position.entryIndex,
      exitIndex: candles.length - 1,
      entryTime: position.entryTime,
      exitTime: lastCandle.time,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl,
      pnlPct: (pnl / (cash - pnl)) * 100,
      reason: "End of data",
      bars: candles.length - 1 - position.entryIndex,
    });
    if (cash > peak) peak = cash;
    equity.push({
      time: lastCandle.time,
      equity: cash,
      drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
    });
  }

  return {
    trades,
    equity,
    signals,
    candles,
    finalEquity: cash,
    startEquity: config.startEquity,
  };
}

/* ------------------------------------------------------------------ */
/*  Full candle-by-candle simulation with SL/TP                        */
/* ------------------------------------------------------------------ */

function runWithStopLoss(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  const signals = getSignals(candles, config.strategy, config.params);
  const signalByIndex = new Map<number, Signal>();
  for (const s of signals) signalByIndex.set(s.index, s);

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const allSignals: Signal[] = [...signals];

  let cash = config.startEquity;
  let peak = cash;
  let position: {
    side: SignalSide;
    entryPrice: number;
    entryIndex: number;
    entryTime: number;
  } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const sig = signalByIndex.get(i);

    // Check SL/TP first if in position
    if (position) {
      let exitPrice: number | null = null;
      let exitReason = "";

      if (position.side === "long") {
        if (config.stopLossPct > 0) {
          const slPrice = position.entryPrice * (1 - config.stopLossPct / 100);
          if (c.low <= slPrice) {
            exitPrice = slPrice;
            exitReason = `Stop-Loss ${config.stopLossPct}%`;
          }
        }
        if (!exitPrice && config.takeProfitPct > 0) {
          const tpPrice = position.entryPrice * (1 + config.takeProfitPct / 100);
          if (c.high >= tpPrice) {
            exitPrice = tpPrice;
            exitReason = `Take-Profit ${config.takeProfitPct}%`;
          }
        }
      } else {
        if (config.stopLossPct > 0) {
          const slPrice = position.entryPrice * (1 + config.stopLossPct / 100);
          if (c.high >= slPrice) {
            exitPrice = slPrice;
            exitReason = `Stop-Loss ${config.stopLossPct}%`;
          }
        }
        if (!exitPrice && config.takeProfitPct > 0) {
          const tpPrice = position.entryPrice * (1 - config.takeProfitPct / 100);
          if (c.low <= tpPrice) {
            exitPrice = tpPrice;
            exitReason = `Take-Profit ${config.takeProfitPct}%`;
          }
        }
      }

      if (exitPrice !== null) {
        let pnl: number;
        if (position.side === "long") {
          pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
        } else {
          pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
        }
        cash += pnl;
        trades.push({
          entryIndex: position.entryIndex,
          exitIndex: i,
          entryTime: position.entryTime,
          exitTime: c.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl,
          pnlPct: (pnl / (cash - pnl)) * 100,
          reason: exitReason,
          bars: i - position.entryIndex,
        });
        if (cash > peak) peak = cash;
        equity.push({
          time: c.time,
          equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
        allSignals.push({
          index: i,
          time: c.time,
          side: position.side,
          action: "exit",
          price: exitPrice,
          reason: exitReason,
        });
        position = null;
      }
    }

    // Process strategy signal
    if (sig) {
      if (position) {
        if (sig.side !== position.side) {
          // Close current, open opposite
          const exitPrice = sig.price;
          let pnl: number;
          if (position.side === "long") {
            pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
          } else {
            pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
          }
          cash += pnl;
          trades.push({
            entryIndex: position.entryIndex,
            exitIndex: i,
            entryTime: position.entryTime,
            exitTime: c.time,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            pnl,
            pnlPct: (pnl / (cash - pnl)) * 100,
            reason: sig.reason,
            bars: i - position.entryIndex,
          });
          if (cash > peak) peak = cash;
          equity.push({
            time: c.time,
            equity: cash,
            drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
          });
          position = {
            side: sig.side,
            entryPrice: sig.price,
            entryIndex: i,
            entryTime: c.time,
          };
        }
      } else {
        // Open position
        position = {
          side: sig.side,
          entryPrice: sig.price,
          entryIndex: i,
          entryTime: c.time,
        };
        equity.push({
          time: c.time,
          equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
      }
    }
  }

  // Close remaining position
  if (position) {
    const last = candles[candles.length - 1];
    let pnl: number;
    if (position.side === "long") {
      pnl = ((last.close - position.entryPrice) / position.entryPrice) * cash;
    } else {
      pnl = ((position.entryPrice - last.close) / position.entryPrice) * cash;
    }
    cash += pnl;
    trades.push({
      entryIndex: position.entryIndex,
      exitIndex: candles.length - 1,
      entryTime: position.entryTime,
      exitTime: last.time,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnl,
      pnlPct: (pnl / (cash - pnl)) * 100,
      reason: "End of data",
      bars: candles.length - 1 - position.entryIndex,
    });
    if (cash > peak) peak = cash;
    equity.push({
      time: last.time,
      equity: cash,
      drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
    });
  }

  return {
    trades,
    equity,
    signals: allSignals,
    candles,
    finalEquity: cash,
    startEquity: config.startEquity,
  };
}

/* ------------------------------------------------------------------ */
/*  Crypto Pulse — dedicated candle-by-candle runner with trailing SL  */
/* ------------------------------------------------------------------ */

function runCryptoPulse(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  const cpConfig = config.params as CryptoPulseConfig;
  const indicators = precomputeIndicators(candles, cpConfig);

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const allSignals: Signal[] = [];

  let cash = config.startEquity;
  let peak = cash;

  let position: {
    side: SignalSide;
    entryPrice: number;
    entryIndex: number;
    entryTime: number;
    stopLoss: number;
    takeProfit: number;
    atrAtEntry: number;
    trailingActivated: boolean;
  } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // ── Check exit on open position first ──
    if (position) {
      const openPos: OpenPosition = {
        direction: position.side === "long" ? "LONG" : "SHORT",
        entryPrice: position.entryPrice,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        atrAtEntry: position.atrAtEntry,
        trailingActivated: position.trailingActivated,
      };

      const exitResult = checkPositionExit(c, openPos, indicators, i, cpConfig);

      if (exitResult.newTrailingStop !== undefined && !exitResult.shouldExit) {
        // Trailing stop activated — move SL to breakeven, keep position open
        position.stopLoss = exitResult.newTrailingStop;
        position.trailingActivated = true;
      } else if (exitResult.shouldExit) {
        // Close position
        const exitPrice = exitResult.exitPrice;
        let pnl: number;
        if (position.side === "long") {
          pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
        } else {
          pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
        }
        const pnlPct = (pnl / cash) * 100;
        cash += pnl;

        trades.push({
          entryIndex: position.entryIndex,
          exitIndex: i,
          entryTime: position.entryTime,
          exitTime: c.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl,
          pnlPct,
          reason: exitResult.reason,
          bars: i - position.entryIndex,
        });

        allSignals.push({
          index: i,
          time: c.time,
          side: position.side,
          action: "exit",
          price: exitPrice,
          reason: exitResult.reason,
        });

        if (cash > peak) peak = cash;
        equity.push({
          time: c.time,
          equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });

        position = null;
      }
    }

    // ── Evaluate for new entry (only if flat) ──
    if (!position) {
      const evalResult = evaluateBar(candles, indicators, i, cpConfig);

      if (evalResult.signal !== "NONE") {
        const side: SignalSide = evalResult.signal === "LONG" ? "long" : "short";
        position = {
          side,
          entryPrice: evalResult.entryPrice,
          entryIndex: i,
          entryTime: c.time,
          stopLoss: evalResult.stopLoss,
          takeProfit: evalResult.takeProfit,
          atrAtEntry: evalResult.atr,
          trailingActivated: false,
        };

        allSignals.push({
          index: i,
          time: c.time,
          side,
          action: "entry",
          price: evalResult.entryPrice,
          reason: evalResult.reason,
        });

        equity.push({
          time: c.time,
          equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
      }
    }
  }

  // Close remaining position at last candle
  if (position) {
    const last = candles[candles.length - 1];
    const exitPrice = last.close;
    let pnl: number;
    if (position.side === "long") {
      pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * cash;
    } else {
      pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * cash;
    }
    cash += pnl;
    trades.push({
      entryIndex: position.entryIndex,
      exitIndex: candles.length - 1,
      entryTime: position.entryTime,
      exitTime: last.time,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl,
      pnlPct: (pnl / (cash - pnl)) * 100,
      reason: "End of data",
      bars: candles.length - 1 - position.entryIndex,
    });
    if (cash > peak) peak = cash;
    equity.push({
      time: last.time,
      equity: cash,
      drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
    });
  }

  return {
    trades,
    equity,
    signals: allSignals,
    candles,
    finalEquity: cash,
    startEquity: config.startEquity,
  };
}

/* ------------------------------------------------------------------ */
/*  Crypto Pulse v2 — 1D runner with ADX, slippage, commission        */
/* ------------------------------------------------------------------ */

function runCryptoPulseV2(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  const v2Cfg = config.params as CryptoPulseV2Config;
  const ind = precomputeV2(candles, v2Cfg);

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const allSignals: Signal[] = [];

  let cash = config.startEquity;
  let peak = cash;

  const minI = Math.max(v2Cfg.emaSlow, v2Cfg.adxPeriod * 2, v2Cfg.rsiPeriod, v2Cfg.atrPeriod) + 10;

  let position: {
    side: SignalSide;
    entryPrice: number;
    entryIndex: number;
    entryTime: number;
    sl: number;
    tp: number;
    atrAtEntry: number;
    trailingActivated: boolean;
    qty: number;
  } | null = null;

  for (let i = minI; i < candles.length; i++) {
    const c = candles[i];

    // ── Check exit on open position ──
    if (position) {
      const openPos: OpenPositionV2 = {
        direction: position.side === "long" ? "LONG" : "SHORT",
        entryPrice: position.entryPrice,
        sl: position.sl,
        tp: position.tp,
        atrAtEntry: position.atrAtEntry,
        trailingActivated: position.trailingActivated,
      };

      const exitResult = checkExitV2(c, openPos, ind, i, v2Cfg);

      if (!exitResult.shouldExit && exitResult.updatedSL !== undefined && !position.trailingActivated) {
        position.sl = exitResult.updatedSL;
        position.trailingActivated = true;
      } else if (exitResult.shouldExit) {
        const rawExit = exitResult.exitPrice;
        const slipped = position.side === "long"
          ? rawExit * (1 - v2Cfg.slippagePct)
          : rawExit * (1 + v2Cfg.slippagePct);

        const pnlPerUnit = position.side === "long"
          ? slipped - position.entryPrice
          : position.entryPrice - slipped;

        const grossPnl = pnlPerUnit * position.qty;
        const commission = (position.entryPrice + slipped) * position.qty * v2Cfg.commissionPct;
        const netPnl = grossPnl - commission;
        const pnlPct = (netPnl / cash) * 100;
        cash += netPnl;

        trades.push({
          entryIndex: position.entryIndex,
          exitIndex: i,
          entryTime: position.entryTime,
          exitTime: c.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: parseFloat(slipped.toFixed(4)),
          pnl: netPnl,
          pnlPct,
          reason: exitResult.reason,
          bars: i - position.entryIndex,
        });

        allSignals.push({
          index: i, time: c.time, side: position.side,
          action: "exit", price: slipped, reason: exitResult.reason,
        });

        if (cash > peak) peak = cash;
        equity.push({
          time: c.time, equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
        position = null;
      }
    }

    // ── Evaluate new entry (only if flat) ──
    if (!position) {
      const sig = evaluateBarV2(candles, ind, i, v2Cfg);

      if (sig.signal !== "NONE") {
        const side: SignalSide = sig.signal === "LONG" ? "long" : "short";
        const entrySlipped = sig.signal === "LONG"
          ? sig.entry * (1 + v2Cfg.slippagePct)
          : sig.entry * (1 - v2Cfg.slippagePct);

        const { qty } = calcPositionV2(cash, entrySlipped, sig.sl, v2Cfg);
        if (qty <= 0) continue;

        position = {
          side,
          entryPrice: parseFloat(entrySlipped.toFixed(4)),
          entryIndex: i,
          entryTime: c.time,
          sl: sig.sl,
          tp: sig.tp,
          atrAtEntry: sig.atr,
          trailingActivated: false,
          qty,
        };

        allSignals.push({
          index: i, time: c.time, side, action: "entry",
          price: entrySlipped, reason: sig.reason,
        });
        equity.push({
          time: c.time, equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
      }
    }
  }

  // Close remaining position at last candle
  if (position) {
    const last = candles[candles.length - 1];
    const pnlPerUnit = position.side === "long"
      ? last.close - position.entryPrice
      : position.entryPrice - last.close;
    const netPnl = pnlPerUnit * position.qty;
    cash += netPnl;

    trades.push({
      entryIndex: position.entryIndex, exitIndex: candles.length - 1,
      entryTime: position.entryTime, exitTime: last.time,
      side: position.side, entryPrice: position.entryPrice,
      exitPrice: last.close, pnl: netPnl,
      pnlPct: (netPnl / (cash - netPnl)) * 100,
      reason: "End of data", bars: candles.length - 1 - position.entryIndex,
    });
    if (cash > peak) peak = cash;
    equity.push({
      time: last.time, equity: cash,
      drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
    });
  }

  return {
    trades, equity, signals: allSignals, candles,
    finalEquity: cash, startEquity: config.startEquity,
  };
}

/* ------------------------------------------------------------------ */
/*  Pulse Scalper 1H — session-filtered scalper with VWAP bias        */
/* ------------------------------------------------------------------ */

function utcDayKey(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function runPulseScalper1H(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  const sCfg = config.params as PulseScalperConfig;
  const ind = precomputeScalper(candles, sCfg);

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const allSignals: Signal[] = [];

  let cash = config.startEquity;
  let peak = cash;

  // Daily tracking
  let currentDayKey = -1;
  let dayTradeCount = 0;
  let dayStartEquity = config.startEquity;

  const minI = Math.max(sCfg.emaSlow, sCfg.rsiPeriod, sCfg.atrPeriod) + 2;

  let position: {
    side: SignalSide;
    entryPrice: number;
    entryIndex: number;
    entryTime: number;
    sl: number;
    tp: number;
    atrAtEntry: number;
    trailingActivated: boolean;
    qty: number;
  } | null = null;

  for (let i = minI; i < candles.length; i++) {
    const c = candles[i];
    const dayKey = utcDayKey(c.time);

    // Reset daily counters on new day
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      dayTradeCount = 0;
      dayStartEquity = cash;
    }

    // Circuit breaker
    const dayLossPct = (dayStartEquity - cash) / dayStartEquity;
    const circuitBroken = dayLossPct >= sCfg.circuitBreakerPct;

    // ── Check exit on open position ──
    if (position) {
      const openPos: ScalperOpenPosition = {
        direction: position.side === "long" ? "LONG" : "SHORT",
        entryPrice: position.entryPrice,
        sl: position.sl,
        tp: position.tp,
        atrAtEntry: position.atrAtEntry,
        trailingActivated: position.trailingActivated,
        entryBarIndex: position.entryIndex,
      };

      const ex = checkExitScalper(c, openPos, i, sCfg);

      if (!ex.shouldExit && ex.updatedSL !== undefined && !position.trailingActivated) {
        position.sl = ex.updatedSL;
        position.trailingActivated = true;
      } else if (ex.shouldExit) {
        const rawExit = ex.exitPrice;
        const slipped = position.side === "long"
          ? rawExit * (1 - sCfg.slippagePct)
          : rawExit * (1 + sCfg.slippagePct);

        const pnlPerUnit = position.side === "long"
          ? slipped - position.entryPrice
          : position.entryPrice - slipped;

        const grossPnl = pnlPerUnit * position.qty;
        const commission = (position.entryPrice + slipped) * position.qty * sCfg.commissionPct;
        const netPnl = grossPnl - commission;
        const pnlPct = (netPnl / cash) * 100;
        cash += netPnl;

        trades.push({
          entryIndex: position.entryIndex, exitIndex: i,
          entryTime: position.entryTime, exitTime: c.time,
          side: position.side, entryPrice: position.entryPrice,
          exitPrice: parseFloat(slipped.toFixed(4)),
          pnl: netPnl, pnlPct,
          reason: ex.reason, bars: i - position.entryIndex,
        });

        allSignals.push({
          index: i, time: c.time, side: position.side,
          action: "exit", price: slipped, reason: ex.reason,
        });

        if (cash > peak) peak = cash;
        equity.push({
          time: c.time, equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
        position = null;
      }
    }

    // ── Evaluate new entry (flat + day limits OK) ──
    if (!position && !circuitBroken && dayTradeCount < sCfg.maxTradesPerDay) {
      const sig = evaluateBarScalper(candles, ind, i, sCfg);

      if (sig.signal !== "NONE") {
        const side: SignalSide = sig.signal === "LONG" ? "long" : "short";
        const entrySlipped = sig.signal === "LONG"
          ? sig.entry * (1 + sCfg.slippagePct)
          : sig.entry * (1 - sCfg.slippagePct);

        const { qty } = calcPositionScalper(cash, entrySlipped, sig.sl, sig.vwapAligned, sCfg);
        if (qty <= 0) continue;

        position = {
          side, entryPrice: parseFloat(entrySlipped.toFixed(4)),
          entryIndex: i, entryTime: c.time,
          sl: sig.sl, tp: sig.tp,
          atrAtEntry: sig.atr, trailingActivated: false, qty,
        };
        dayTradeCount++;

        allSignals.push({
          index: i, time: c.time, side, action: "entry",
          price: entrySlipped, reason: sig.reason,
        });
        equity.push({
          time: c.time, equity: cash,
          drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
        });
      }
    }
  }

  // Close remaining position
  if (position) {
    const last = candles[candles.length - 1];
    const pnlPerUnit = position.side === "long"
      ? last.close - position.entryPrice
      : position.entryPrice - last.close;
    const netPnl = pnlPerUnit * position.qty;
    cash += netPnl;

    trades.push({
      entryIndex: position.entryIndex, exitIndex: candles.length - 1,
      entryTime: position.entryTime, exitTime: last.time,
      side: position.side, entryPrice: position.entryPrice,
      exitPrice: last.close, pnl: netPnl,
      pnlPct: (netPnl / (cash - netPnl)) * 100,
      reason: "End of data", bars: candles.length - 1 - position.entryIndex,
    });
    if (cash > peak) peak = cash;
    equity.push({
      time: last.time, equity: cash,
      drawdown: peak > 0 ? ((peak - cash) / peak) * 100 : 0,
    });
  }

  return {
    trades, equity, signals: allSignals, candles,
    finalEquity: cash, startEquity: config.startEquity,
  };
}
