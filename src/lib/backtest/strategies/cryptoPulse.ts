// src/lib/backtest/strategies/cryptoPulse.ts
//
// Crypto Pulse — estrategia híbrida tendencia + rebote para criptos
// Diseñada para operar en CUALQUIER par USDT con volumen > 50M diario
// Timeframe principal: 4H
//
// Diferencias clave respecto a EMA Trend Momentum:
//   1. Stop Loss y Take Profit basados en ATR (se adaptan a cada par)
//   2. Detecta si el mercado está en tendencia o en rango y cambia de modo
//   3. Trailing stop a breakeven cuando el precio avanza 1×ATR
//   4. Opera hasta 3 pares en paralelo con riesgo de 1.5% cada uno
//
// INTEGRACIÓN EN EL BACKTESTER EXISTENTE:
//   Añadir "crypto_pulse" al switch de estrategias en backtest-engine.ts
//   siguiendo el mismo patrón que las estrategias ya existentes.

import type { Candle } from "@/lib/binance/types";

// ─────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────

export type CryptoPulseSignal = "LONG" | "SHORT" | "NONE";
export type MarketRegime = "TREND" | "RANGE";

export interface CryptoPulseConfig {
  emaFast: number;          // default 21
  emaSlow: number;          // default 55
  rsiPeriod: number;        // default 14
  atrPeriod: number;        // default 14
  volumeLookback: number;   // default 20

  // Umbrales de régimen
  trendSeparationPct: number; // % de separación EMA21/EMA55 para considerar tendencia (default 0.3)

  // Multiplicadores ATR para SL y TP
  atrSlMultiplier: number;  // default 1.5
  atrTpMultiplier: number;  // default 3.0

  // Volumen relativo mínimo
  volumeMultiplierTrend: number; // default 1.5 (modo tendencia)
  volumeMultiplierRange: number; // default 1.2 (modo rango)

  // Umbrales RSI
  rsiOverbought: number;    // default 78 (salida forzada long)
  rsiOversold: number;      // default 22 (salida forzada short)
  rsiMidCrossMin: number;   // default 48 (cruce alcista RSI)
  rsiMidCrossMax: number;   // default 52 (cruce bajista RSI)
  rsiRangeLong: number;     // default 35 (rebote alcista en rango)
  rsiRangeShort: number;    // default 65 (rebote bajista en rango)

  // Gestión de riesgo
  riskPerTrade: number;     // default 0.015 (1.5%)
  maxOpenPositions: number; // default 3
}

export interface CryptoPulseResult {
  signal: CryptoPulseSignal;
  regime: MarketRegime;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  rsi: number;
  emaFast: number;
  emaSlow: number;
  reason: string;
}

export const DEFAULT_CRYPTO_PULSE_CONFIG: CryptoPulseConfig = {
  emaFast: 21,
  emaSlow: 55,
  rsiPeriod: 14,
  atrPeriod: 14,
  volumeLookback: 20,
  trendSeparationPct: 0.3,
  atrSlMultiplier: 1.5,
  atrTpMultiplier: 3.0,
  volumeMultiplierTrend: 1.5,
  volumeMultiplierRange: 1.2,
  rsiOverbought: 78,
  rsiOversold: 22,
  rsiMidCrossMin: 48,
  rsiMidCrossMax: 52,
  rsiRangeLong: 35,
  rsiRangeShort: 65,
  riskPerTrade: 0.015,
  maxOpenPositions: 3,
};

// ─────────────────────────────────────────────────────────────────
// Cálculo de indicadores puros
// ─────────────────────────────────────────────────────────────────

/**
 * EMA usando el método estándar con seeding por SMA.
 * Devuelve array del mismo tamaño que candles (NaN durante warmup).
 */
export function calcEMA(candles: Candle[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period) return result;

  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

/**
 * RSI de Wilder (suavizado exponencial).
 * Devuelve array del mismo tamaño que candles.
 */
export function calcRSI(candles: Candle[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }
  return result;
}

/**
 * ATR — Average True Range de Wilder.
 * True Range = max(H-L, |H-Cprev|, |L-Cprev|)
 */
export function calcATR(candles: Candle[], period: number): number[] {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
    trs.push(tr);
  }

  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  result[period] = atr;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result[i + 1] = atr;
  }
  return result;
}

/**
 * Volumen medio simple de las últimas N velas (sin incluir la actual).
 */
function avgVolume(candles: Candle[], idx: number, lookback: number): number {
  const start = Math.max(1, idx - lookback);
  const slice = candles.slice(start, idx);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

/**
 * Detecta vela envolvente alcista (bullish engulfing):
 * vela anterior bajista + vela actual cierra por encima del máximo anterior.
 */
function isBullishEngulfing(prev: Candle, curr: Candle): boolean {
  return prev.close < prev.open &&
    curr.close > curr.open &&
    curr.close > prev.open &&
    curr.open < prev.close;
}

/**
 * Detecta vela envolvente bajista (bearish engulfing).
 */
function isBearishEngulfing(prev: Candle, curr: Candle): boolean {
  return prev.close > prev.open &&
    curr.close < curr.open &&
    curr.close < prev.open &&
    curr.open > prev.close;
}

// ─────────────────────────────────────────────────────────────────
// Motor principal de la estrategia
// ─────────────────────────────────────────────────────────────────

/**
 * Precalcula todos los indicadores sobre el array de velas.
 * Devuelve los arrays para ser usados en evaluateBar().
 * Llamar una vez por backtest, no en cada barra.
 */
export interface CryptoPulseIndicators {
  emaFastArr: number[];
  emaSlowArr: number[];
  rsiArr: number[];
  atrArr: number[];
}

export function precomputeIndicators(
  candles: Candle[],
  config: CryptoPulseConfig = DEFAULT_CRYPTO_PULSE_CONFIG
): CryptoPulseIndicators {
  return {
    emaFastArr: calcEMA(candles, config.emaFast),
    emaSlowArr: calcEMA(candles, config.emaSlow),
    rsiArr:     calcRSI(candles, config.rsiPeriod),
    atrArr:     calcATR(candles, config.atrPeriod),
  };
}

/**
 * Evalúa la estrategia en la barra i (vela cerrada).
 * Usa los indicadores precalculados para eficiencia.
 *
 * @param candles    - Array completo de velas
 * @param indicators - Indicadores precalculados con precomputeIndicators()
 * @param i          - Índice de la barra actual (debe ser vela cerrada)
 * @param config     - Configuración de la estrategia
 */
export function evaluateBar(
  candles: Candle[],
  indicators: CryptoPulseIndicators,
  i: number,
  config: CryptoPulseConfig = DEFAULT_CRYPTO_PULSE_CONFIG
): CryptoPulseResult {
  const noSignal: CryptoPulseResult = {
    signal: "NONE", regime: "RANGE",
    entryPrice: 0, stopLoss: 0, takeProfit: 0,
    atr: 0, rsi: 0, emaFast: 0, emaSlow: 0,
    reason: "Sin señal",
  };

  const minIdx = Math.max(config.emaSlow, config.rsiPeriod, config.atrPeriod) + 2;
  if (i < minIdx) return { ...noSignal, reason: `Warmup (${i}/${minIdx})` };

  const { emaFastArr, emaSlowArr, rsiArr, atrArr } = indicators;

  const emaFast     = emaFastArr[i];
  const emaSlow     = emaSlowArr[i];
  const emaFastPrev = emaFastArr[i - 1];
  const emaSlowPrev = emaSlowArr[i - 1];
  const rsi         = rsiArr[i];
  const rsiPrev     = rsiArr[i - 1];
  const atr         = atrArr[i];

  if (isNaN(emaFast) || isNaN(emaSlow) || isNaN(rsi) || isNaN(atr) || atr === 0) {
    return { ...noSignal, reason: "Indicadores no disponibles" };
  }

  const candle     = candles[i];
  const prevCandle = candles[i - 1];
  const close      = candle.close;

  // ── Régimen de mercado ────────────────────────────────────────
  const separationPct = Math.abs(emaFast - emaSlow) / emaSlow * 100;
  const regime: MarketRegime = separationPct >= config.trendSeparationPct ? "TREND" : "RANGE";

  // ── Volumen relativo ──────────────────────────────────────────
  const volAvg = avgVolume(candles, i, config.volumeLookback);
  const volMultiplier = regime === "TREND"
    ? config.volumeMultiplierTrend
    : config.volumeMultiplierRange;
  const volConfirmed = volAvg > 0 && candle.volume >= volAvg * volMultiplier;

  // ── SL y TP basados en ATR ────────────────────────────────────
  const slDistance = atr * config.atrSlMultiplier;
  const tpDistance = atr * config.atrTpMultiplier;

  // ═══════════════════════════════════════════════════════════════
  // MODO TENDENCIA
  // ═══════════════════════════════════════════════════════════════
  if (regime === "TREND") {
    // LONG en tendencia
    if (
      emaFast > emaSlow &&                           // EMA21 por encima de EMA55
      rsiPrev < config.rsiMidCrossMin &&             // RSI cruzó 50 hacia arriba
      rsi >= config.rsiMidCrossMax &&
      close > emaFast &&                             // precio cierra por encima de EMA21
      volConfirmed
    ) {
      return {
        signal: "LONG",
        regime,
        entryPrice: close,
        stopLoss:   parseFloat((close - slDistance).toFixed(4)),
        takeProfit: parseFloat((close + tpDistance).toFixed(4)),
        atr, rsi, emaFast, emaSlow,
        reason: `TREND LONG | EMA21>EMA55 | RSI cruza 50↑ (${rsi.toFixed(0)}) | Vol ✓`,
      };
    }

    // SHORT en tendencia
    if (
      emaFast < emaSlow &&
      rsiPrev > config.rsiMidCrossMax &&
      rsi <= config.rsiMidCrossMin &&
      close < emaFast &&
      volConfirmed
    ) {
      return {
        signal: "SHORT",
        regime,
        entryPrice: close,
        stopLoss:   parseFloat((close + slDistance).toFixed(4)),
        takeProfit: parseFloat((close - tpDistance).toFixed(4)),
        atr, rsi, emaFast, emaSlow,
        reason: `TREND SHORT | EMA21<EMA55 | RSI cruza 50↓ (${rsi.toFixed(0)}) | Vol ✓`,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MODO RANGO
  // ═══════════════════════════════════════════════════════════════
  if (regime === "RANGE") {
    // LONG en rango: RSI rebota desde zona oversold + precio rebota en EMA55 + engulfing
    const touchingEmaSlow = Math.abs(candle.low - emaSlow) / emaSlow < 0.005; // precio tocó EMA55 con 0.5% tolerancia
    const closingAboveEma = close > emaSlow;
    const bullEngulf = isBullishEngulfing(prevCandle, candle);

    if (
      rsiPrev <= config.rsiRangeLong &&
      rsi > rsiPrev &&                               // RSI rebota (empieza a subir)
      (touchingEmaSlow || closingAboveEma) &&
      (bullEngulf || volConfirmed)
    ) {
      return {
        signal: "LONG",
        regime,
        entryPrice: close,
        stopLoss:   parseFloat((close - slDistance).toFixed(4)),
        takeProfit: parseFloat((close + tpDistance).toFixed(4)),
        atr, rsi, emaFast, emaSlow,
        reason: `RANGE LONG | RSI rebota ${rsiPrev.toFixed(0)}→${rsi.toFixed(0)} | EMA55 soporte${bullEngulf ? " | Engulf" : ""}`,
      };
    }

    // SHORT en rango: RSI rebota desde zona overbought
    const touchingEmaSlowTop = Math.abs(candle.high - emaSlow) / emaSlow < 0.005;
    const closingBelowEma = close < emaSlow;
    const bearEngulf = isBearishEngulfing(prevCandle, candle);

    if (
      rsiPrev >= config.rsiRangeShort &&
      rsi < rsiPrev &&
      (touchingEmaSlowTop || closingBelowEma) &&
      (bearEngulf || volConfirmed)
    ) {
      return {
        signal: "SHORT",
        regime,
        entryPrice: close,
        stopLoss:   parseFloat((close + slDistance).toFixed(4)),
        takeProfit: parseFloat((close - tpDistance).toFixed(4)),
        atr, rsi, emaFast, emaSlow,
        reason: `RANGE SHORT | RSI gira ${rsiPrev.toFixed(0)}→${rsi.toFixed(0)} | EMA55 resist${bearEngulf ? " | Engulf" : ""}`,
      };
    }
  }

  return {
    ...noSignal,
    regime,
    atr, rsi, emaFast, emaSlow,
    reason: `${regime} | EMA sep ${separationPct.toFixed(2)}% | RSI ${rsi.toFixed(0)} | Vol ${volConfirmed ? "✓" : "✗"}`,
  };
}

// ─────────────────────────────────────────────────────────────────
// Verificación de salida de posición abierta
// ─────────────────────────────────────────────────────────────────

export type ExitType = "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "RSI_EXTREME" | "EMA_CROSS" | "NONE";

export interface ExitResult {
  shouldExit: boolean;
  exitType: ExitType;
  exitPrice: number;
  reason: string;
  newTrailingStop?: number; // si el trailing stop sube, devuelve el nuevo nivel
}

export interface OpenPosition {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;          // SL actual (puede haber subido por trailing)
  takeProfit: number;
  atrAtEntry: number;
  trailingActivated: boolean; // true cuando el precio avanzó 1×ATR
}

/**
 * Evalúa si una posición abierta debe cerrarse.
 * Gestiona también el trailing stop a breakeven.
 */
export function checkPositionExit(
  candle: Candle,
  position: OpenPosition,
  indicators: CryptoPulseIndicators,
  i: number,
  config: CryptoPulseConfig = DEFAULT_CRYPTO_PULSE_CONFIG
): ExitResult {
  const noExit: ExitResult = { shouldExit: false, exitType: "NONE", exitPrice: 0, reason: "Mantener" };

  const rsi      = indicators.rsiArr[i];
  const emaFast  = indicators.emaFastArr[i];
  const emaFastP = indicators.emaFastArr[i - 1];
  const emaSlow  = indicators.emaSlowArr[i];
  const emaSlowP = indicators.emaSlowArr[i - 1];

  if (position.direction === "LONG") {
    // Stop Loss
    if (candle.low <= position.stopLoss) {
      return { shouldExit: true, exitType: "STOP_LOSS", exitPrice: position.stopLoss, reason: `SL tocado: ${candle.low} ≤ ${position.stopLoss}` };
    }
    // Take Profit
    if (candle.high >= position.takeProfit) {
      return { shouldExit: true, exitType: "TAKE_PROFIT", exitPrice: position.takeProfit, reason: `TP alcanzado: ${candle.high} ≥ ${position.takeProfit}` };
    }
    // RSI extremo
    if (!isNaN(rsi) && rsi > config.rsiOverbought) {
      return { shouldExit: true, exitType: "RSI_EXTREME", exitPrice: candle.close, reason: `RSI sobrecomprado: ${rsi.toFixed(0)} > ${config.rsiOverbought}` };
    }
    // Cruce EMA en contra
    if (!isNaN(emaFast) && !isNaN(emaSlow) && !isNaN(emaFastP) && !isNaN(emaSlowP)) {
      if (emaFastP > emaSlowP && emaFast < emaSlow) {
        return { shouldExit: true, exitType: "EMA_CROSS", exitPrice: candle.close, reason: "EMA21 cruzó EMA55 hacia abajo" };
      }
    }
    // Trailing stop: si el precio avanzó 1×ATR, mover SL a breakeven
    if (!position.trailingActivated && candle.close >= position.entryPrice + position.atrAtEntry) {
      return {
        shouldExit: false,
        exitType: "NONE",
        exitPrice: 0,
        reason: "Trailing: SL movido a breakeven",
        newTrailingStop: position.entryPrice,
      };
    }
  }

  if (position.direction === "SHORT") {
    if (candle.high >= position.stopLoss) {
      return { shouldExit: true, exitType: "STOP_LOSS", exitPrice: position.stopLoss, reason: `SL tocado: ${candle.high} ≥ ${position.stopLoss}` };
    }
    if (candle.low <= position.takeProfit) {
      return { shouldExit: true, exitType: "TAKE_PROFIT", exitPrice: position.takeProfit, reason: `TP alcanzado: ${candle.low} ≤ ${position.takeProfit}` };
    }
    if (!isNaN(rsi) && rsi < config.rsiOversold) {
      return { shouldExit: true, exitType: "RSI_EXTREME", exitPrice: candle.close, reason: `RSI sobrevendido: ${rsi.toFixed(0)} < ${config.rsiOversold}` };
    }
    if (!isNaN(emaFast) && !isNaN(emaSlow) && !isNaN(emaFastP) && !isNaN(emaSlowP)) {
      if (emaFastP < emaSlowP && emaFast > emaSlow) {
        return { shouldExit: true, exitType: "EMA_CROSS", exitPrice: candle.close, reason: "EMA21 cruzó EMA55 hacia arriba" };
      }
    }
    if (!position.trailingActivated && candle.close <= position.entryPrice - position.atrAtEntry) {
      return {
        shouldExit: false,
        exitType: "NONE",
        exitPrice: 0,
        reason: "Trailing: SL movido a breakeven",
        newTrailingStop: position.entryPrice,
      };
    }
  }

  return noExit;
}

// ─────────────────────────────────────────────────────────────────
// Tamaño de posición con capital compuesto
// ─────────────────────────────────────────────────────────────────

/**
 * Calcula el tamaño de posición (en USDT) ajustado al ATR.
 * El riesgo real = capital × riskPerTrade,
 * independientemente de cuán volátil sea el par.
 */
export function calcPositionSize(
  capital: number,
  entryPrice: number,
  stopLoss: number,
  config: CryptoPulseConfig = DEFAULT_CRYPTO_PULSE_CONFIG
): { positionUSDT: number; riskAmount: number; qty: number } {
  const riskAmount   = capital * config.riskPerTrade;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) return { positionUSDT: 0, riskAmount, qty: 0 };

  const qty          = riskAmount / stopDistance;
  const positionUSDT = qty * entryPrice;

  return {
    positionUSDT: parseFloat(positionUSDT.toFixed(2)),
    riskAmount:   parseFloat(riskAmount.toFixed(2)),
    qty:          parseFloat(qty.toFixed(6)),
  };
}
