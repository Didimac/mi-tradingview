// src/lib/backtest/strategies/cryptoPulseV2.ts
//
// ═══════════════════════════════════════════════════════════════════
// Crypto Pulse v2 — Diario (1D)
// ═══════════════════════════════════════════════════════════════════
//
// Mejoras respecto a v1 (basadas en el informe del 23/05/2026):
//
//   1. Timeframe 1D  — señales más limpias, menos ruido intradía
//   2. RSI ampliado  — umbrales 45/55 (antes 48/52) para más señales
//                      en modo tendencia sin perder calidad
//   3. ADX > 20      — filtro de fuerza de tendencia en TREND mode
//                      evita entradas en tendencias débiles (culpable
//                      principal de las pérdidas en ETH y BNB)
//   4. ATR multipliers ajustados para 1D:
//                      SL = 1.8× ATR (más espacio por velas más grandes)
//                      TP = 3.6× ATR (mantiene ratio 1:2)
//   5. Trailing stop mejorado: se activa a 1.2×ATR (antes 1×ATR)
//      y mueve SL a entry + 0.3×ATR (no a breakeven exacto)
//      para compensar el spread de velas diarias
//
// Top 10 pares por volumen:
//   BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT,
//   DOGEUSDT, ADAUSDT, AVAXUSDT, LINKUSDT, TONUSDT
//
// ───────────────────────────────────────────────────────────────────
// INTEGRACIÓN (mismo patrón que cryptoPulse.ts):
//   1. Copiar a src/lib/backtest/strategies/cryptoPulseV2.ts
//   2. En backtest-engine.ts añadir case "crypto_pulse_v2"
//   3. En BacktestPanel.tsx añadir opción "Crypto Pulse v2 (1D)"
// ───────────────────────────────────────────────────────────────────

import type { Candle } from "@/lib/binance/types";

// ─────────────────────────────────────────────────────────────────
// Tipos y configuración
// ─────────────────────────────────────────────────────────────────

export type SignalV2   = "LONG" | "SHORT" | "NONE";
export type RegimeV2  = "TREND" | "RANGE";
export type ExitTypeV2 =
  | "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP"
  | "RSI_EXTREME" | "EMA_CROSS" | "NONE";

export interface CryptoPulseV2Config {
  // Indicadores
  emaFast:            number;   // 21
  emaSlow:            number;   // 55
  rsiPeriod:          number;   // 14
  atrPeriod:          number;   // 14
  adxPeriod:          number;   // 14
  volumeLookback:     number;   // 20

  // Régimen
  trendSeparationPct: number;   // 0.3  — % separación EMA para TREND
  adxTrendMin:        number;   // 20   — ADX mínimo en modo TREND

  // ATR multipliers (ajustados para 1D)
  atrSlMult:          number;   // 1.8
  atrTpMult:          number;   // 3.6

  // RSI thresholds (ampliados en v2)
  rsiOverbought:      number;   // 78
  rsiOversold:        number;   // 22
  rsiCrossUp:         number;   // 45  (antes 48)
  rsiCrossDown:       number;   // 55  (antes 52)
  rsiRangeLong:       number;   // 35
  rsiRangeShort:      number;   // 65

  // Volumen
  volMultTrend:       number;   // 1.4  (ligeramente relajado para 1D)
  volMultRange:       number;   // 1.1

  // Trailing stop mejorado
  trailingActivation: number;   // 1.2  — activa cuando precio avanza 1.2×ATR
  trailingNewSL:      number;   // 0.3  — mueve SL a entry + 0.3×ATR

  // Riesgo
  riskPerTrade:       number;   // 0.015
  commissionPct:      number;   // 0.001
  slippagePct:        number;   // 0.0003  (menor en 1D, más liquidez)
}

export const DEFAULT_V2_CONFIG: CryptoPulseV2Config = {
  emaFast:            21,
  emaSlow:            55,
  rsiPeriod:          14,
  atrPeriod:          14,
  adxPeriod:          14,
  volumeLookback:     20,
  trendSeparationPct: 0.3,
  adxTrendMin:        20,
  atrSlMult:          1.8,
  atrTpMult:          3.6,
  rsiOverbought:      78,
  rsiOversold:        22,
  rsiCrossUp:         45,
  rsiCrossDown:       55,
  rsiRangeLong:       35,
  rsiRangeShort:      65,
  volMultTrend:       1.4,
  volMultRange:       1.1,
  trailingActivation: 1.2,
  trailingNewSL:      0.3,
  riskPerTrade:       0.015,
  commissionPct:      0.001,
  slippagePct:        0.0003,
};

// Top 10 pares por volumen para usar en el panel
export const TOP10_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT",
] as const;

// ─────────────────────────────────────────────────────────────────
// Indicadores
// ─────────────────────────────────────────────────────────────────

export interface V2Indicators {
  emaFast: number[];
  emaSlow: number[];
  rsi:     number[];
  atr:     number[];
  adx:     number[];   // NEW en v2
  plusDI:  number[];   // Directional indicator +DI
  minusDI: number[];   // Directional indicator -DI
}

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
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low  - candles[i].close)
  ));
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

/**
 * ADX + DI+/DI- usando el método de Wilder.
 * ADX mide la FUERZA de la tendencia (no la dirección):
 *   < 20 = tendencia débil o lateral
 *   20-25 = tendencia emergente
 *   > 25 = tendencia fuerte
 */
function calcADX(candles: Candle[], period: number): {
  adx: number[]; plusDI: number[]; minusDI: number[];
} {
  const n = candles.length;
  const adxOut  = new Array(n).fill(NaN);
  const pDIOut  = new Array(n).fill(NaN);
  const mDIOut  = new Array(n).fill(NaN);

  if (n < period * 2 + 1) return { adx: adxOut, plusDI: pDIOut, minusDI: mDIOut };

  // True range y movimientos direccionales
  const tr   = new Array(n).fill(0);
  const pDM  = new Array(n).fill(0);  // +DM
  const mDM  = new Array(n).fill(0);  // -DM

  for (let i = 1; i < n; i++) {
    const upMove   = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    tr[i]  = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
    pDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    mDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder smoothing (suma inicial)
  let sTR  = tr.slice(1, period + 1).reduce((s, v) => s + v, 0);
  let sPDM = pDM.slice(1, period + 1).reduce((s, v) => s + v, 0);
  let sMDM = mDM.slice(1, period + 1).reduce((s, v) => s + v, 0);

  const pDI14 = new Array(n).fill(NaN);
  const mDI14 = new Array(n).fill(NaN);
  const dx    = new Array(n).fill(NaN);

  pDI14[period] = sTR > 0 ? (sPDM / sTR) * 100 : 0;
  mDI14[period] = sTR > 0 ? (sMDM / sTR) * 100 : 0;
  const sum = pDI14[period] + mDI14[period];
  dx[period]    = sum > 0 ? Math.abs(pDI14[period] - mDI14[period]) / sum * 100 : 0;

  for (let i = period + 1; i < n; i++) {
    sTR  = sTR  - sTR  / period + tr[i];
    sPDM = sPDM - sPDM / period + pDM[i];
    sMDM = sMDM - sMDM / period + mDM[i];

    pDI14[i] = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    mDI14[i] = sTR > 0 ? (sMDM / sTR) * 100 : 0;

    const s2 = pDI14[i] + mDI14[i];
    dx[i] = s2 > 0 ? Math.abs(pDI14[i] - mDI14[i]) / s2 * 100 : 0;
    pDIOut[i] = pDI14[i];
    mDIOut[i] = mDI14[i];
  }

  // ADX = EMA del DX con periodo Wilder
  let adxVal = dx.slice(period, period * 2).filter(v => !isNaN(v))
    .reduce((s, v) => s + v, 0) / period;
  adxOut[period * 2 - 1] = adxVal;

  for (let i = period * 2; i < n; i++) {
    if (!isNaN(dx[i])) {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      adxOut[i] = adxVal;
    }
  }

  return { adx: adxOut, plusDI: pDIOut, minusDI: mDIOut };
}

function avgVol(candles: Candle[], idx: number, lookback: number): number {
  const sl = candles.slice(Math.max(1, idx - lookback), idx);
  return sl.length === 0 ? 0 : sl.reduce((s, c) => s + c.volume, 0) / sl.length;
}

function bullEngulf(p: Candle, c: Candle): boolean {
  return p.close < p.open && c.close > c.open &&
         c.close > p.open && c.open < p.close;
}

function bearEngulf(p: Candle, c: Candle): boolean {
  return p.close > p.open && c.close < c.open &&
         c.close < p.open && c.open > p.close;
}

// ─────────────────────────────────────────────────────────────────
// Precomputar todos los indicadores (llamar una vez por backtest)
// ─────────────────────────────────────────────────────────────────

export function precomputeV2(
  candles: Candle[],
  cfg: CryptoPulseV2Config = DEFAULT_V2_CONFIG
): V2Indicators {
  const { adx, plusDI, minusDI } = calcADX(candles, cfg.adxPeriod);
  return {
    emaFast: calcEMA(candles, cfg.emaFast),
    emaSlow: calcEMA(candles, cfg.emaSlow),
    rsi:     calcRSI(candles, cfg.rsiPeriod),
    atr:     calcATR(candles, cfg.atrPeriod),
    adx,
    plusDI,
    minusDI,
  };
}

// ─────────────────────────────────────────────────────────────────
// Evaluación de señal en barra cerrada
// ─────────────────────────────────────────────────────────────────

export interface SignalResultV2 {
  signal:    SignalV2;
  regime:    RegimeV2;
  entry:     number;
  sl:        number;
  tp:        number;
  atr:       number;
  adx:       number;
  rsi:       number;
  reason:    string;
}

export function evaluateBarV2(
  candles:    Candle[],
  ind:        V2Indicators,
  i:          number,
  cfg:        CryptoPulseV2Config = DEFAULT_V2_CONFIG
): SignalResultV2 {
  const none: SignalResultV2 = {
    signal: "NONE", regime: "RANGE",
    entry: 0, sl: 0, tp: 0, atr: 0, adx: 0, rsi: 0,
    reason: "Sin señal",
  };

  // Warmup mínimo: necesitamos 2×adxPeriod para el ADX + emaSlow
  const minI = Math.max(cfg.emaSlow, cfg.rsiPeriod, cfg.atrPeriod, cfg.adxPeriod * 2) + 2;
  if (i < minI) return { ...none, reason: `Warmup (${i}/${minI})` };

  const ef  = ind.emaFast[i];
  const es  = ind.emaSlow[i];
  const rsi  = ind.rsi[i];
  const rsiP = ind.rsi[i - 1];
  const atr  = ind.atr[i];
  const adx  = ind.adx[i];

  if ([ef, es, rsi, atr].some(isNaN) || atr === 0) {
    return { ...none, reason: "Indicadores no disponibles" };
  }

  const c  = candles[i];
  const cP = candles[i - 1];

  // ── Régimen ─────────────────────────────────────────────────────
  const sepPct = Math.abs(ef - es) / es * 100;
  const regime: RegimeV2 = sepPct >= cfg.trendSeparationPct ? "TREND" : "RANGE";

  // ── Volumen ─────────────────────────────────────────────────────
  const va  = avgVol(candles, i, cfg.volumeLookback);
  const vm  = regime === "TREND" ? cfg.volMultTrend : cfg.volMultRange;
  const volOk = va > 0 && c.volume >= va * vm;

  // ── SL / TP basados en ATR ───────────────────────────────────────
  const slDist = atr * cfg.atrSlMult;
  const tpDist = atr * cfg.atrTpMult;

  // ═══════════════════════════════════════════════════════════════
  // MODO TENDENCIA (con filtro ADX — NOVEDAD v2)
  // ═══════════════════════════════════════════════════════════════
  if (regime === "TREND") {
    const adxOk = !isNaN(adx) && adx >= cfg.adxTrendMin;

    // LONG tendencia
    if (
      ef > es &&                                  // EMA21 encima EMA55
      adxOk &&                                    // ADX confirma fuerza
      rsiP < cfg.rsiCrossUp &&                    // RSI cruzó 45 hacia arriba (ampliado)
      rsi  >= cfg.rsiCrossUp &&
      c.close > ef &&                             // precio sobre EMA21
      volOk
    ) {
      return {
        signal: "LONG", regime,
        entry: c.close,
        sl: parseFloat((c.close - slDist).toFixed(4)),
        tp: parseFloat((c.close + tpDist).toFixed(4)),
        atr, adx, rsi,
        reason: `TREND LONG | ADX ${adx.toFixed(0)} | RSI ${rsiP.toFixed(0)}→${rsi.toFixed(0)} | Vol ✓`,
      };
    }

    // SHORT tendencia
    if (
      ef < es &&
      adxOk &&
      rsiP > cfg.rsiCrossDown &&
      rsi  <= cfg.rsiCrossDown &&
      c.close < ef &&
      volOk
    ) {
      return {
        signal: "SHORT", regime,
        entry: c.close,
        sl: parseFloat((c.close + slDist).toFixed(4)),
        tp: parseFloat((c.close - tpDist).toFixed(4)),
        atr, adx, rsi,
        reason: `TREND SHORT | ADX ${adx.toFixed(0)} | RSI ${rsiP.toFixed(0)}→${rsi.toFixed(0)} | Vol ✓`,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MODO RANGO (igual que v1, sin ADX obligatorio)
  // ═══════════════════════════════════════════════════════════════
  if (regime === "RANGE") {
    const touchSup = Math.abs(c.low  - es) / es < 0.008;  // 0.8% tolerancia (más en 1D)
    const touchRes = Math.abs(c.high - es) / es < 0.008;

    // LONG rango: rebote alcista en EMA55
    if (
      rsiP <= cfg.rsiRangeLong &&
      rsi > rsiP &&
      (touchSup || c.close > es) &&
      (bullEngulf(cP, c) || volOk)
    ) {
      return {
        signal: "LONG", regime,
        entry: c.close,
        sl: parseFloat((c.close - slDist).toFixed(4)),
        tp: parseFloat((c.close + tpDist).toFixed(4)),
        atr, adx: isNaN(adx) ? 0 : adx, rsi,
        reason: `RANGE LONG | RSI ${rsiP.toFixed(0)}→${rsi.toFixed(0)} | EMA55 soporte${bullEngulf(cP, c) ? " | Engulf" : ""}`,
      };
    }

    // SHORT rango: rebote bajista en EMA55
    if (
      rsiP >= cfg.rsiRangeShort &&
      rsi < rsiP &&
      (touchRes || c.close < es) &&
      (bearEngulf(cP, c) || volOk)
    ) {
      return {
        signal: "SHORT", regime,
        entry: c.close,
        sl: parseFloat((c.close + slDist).toFixed(4)),
        tp: parseFloat((c.close - tpDist).toFixed(4)),
        atr, adx: isNaN(adx) ? 0 : adx, rsi,
        reason: `RANGE SHORT | RSI ${rsiP.toFixed(0)}→${rsi.toFixed(0)} | EMA55 resist${bearEngulf(cP, c) ? " | Engulf" : ""}`,
      };
    }
  }

  const adxStr = isNaN(adx) ? "N/A" : adx.toFixed(0);
  return {
    ...none, regime,
    atr, adx: isNaN(adx) ? 0 : adx, rsi,
    reason: `${regime} | EMA sep ${sepPct.toFixed(2)}% | ADX ${adxStr} | RSI ${rsi.toFixed(0)} | Vol ${volOk ? "✓" : "✗"}`,
  };
}

// ─────────────────────────────────────────────────────────────────
// Verificación de salida con trailing stop mejorado
// ─────────────────────────────────────────────────────────────────

export interface OpenPositionV2 {
  direction:          "LONG" | "SHORT";
  entryPrice:         number;
  sl:                 number;   // SL dinámico (puede actualizarse)
  tp:                 number;
  atrAtEntry:         number;
  trailingActivated:  boolean;
}

export interface ExitResultV2 {
  shouldExit:       boolean;
  exitType:         ExitTypeV2;
  exitPrice:        number;
  reason:           string;
  updatedSL?:       number;    // nuevo SL si se activa trailing (sin cerrar)
}

export function checkExitV2(
  candle:   Candle,
  pos:      OpenPositionV2,
  ind:      V2Indicators,
  i:        number,
  cfg:      CryptoPulseV2Config = DEFAULT_V2_CONFIG
): ExitResultV2 {
  const hold: ExitResultV2 = { shouldExit: false, exitType: "NONE", exitPrice: 0, reason: "Mantener" };

  const rsi  = ind.rsi[i];
  const ef   = ind.emaFast[i];
  const efP  = ind.emaFast[i - 1];
  const es   = ind.emaSlow[i];
  const esP  = ind.emaSlow[i - 1];

  if (pos.direction === "LONG") {
    // Stop loss
    if (candle.low <= pos.sl)
      return { shouldExit: true, exitType: "STOP_LOSS", exitPrice: pos.sl, reason: `SL: low ${candle.low.toFixed(2)} <= ${pos.sl.toFixed(2)}` };

    // Take profit
    if (candle.high >= pos.tp)
      return { shouldExit: true, exitType: "TAKE_PROFIT", exitPrice: pos.tp, reason: `TP: high ${candle.high.toFixed(2)} >= ${pos.tp.toFixed(2)}` };

    // RSI extremo
    if (!isNaN(rsi) && rsi > cfg.rsiOverbought)
      return { shouldExit: true, exitType: "RSI_EXTREME", exitPrice: candle.close, reason: `RSI OB: ${rsi.toFixed(0)} > ${cfg.rsiOverbought}` };

    // Cruce EMA en contra
    if (![ef, efP, es, esP].some(isNaN) && efP > esP && ef < es)
      return { shouldExit: true, exitType: "EMA_CROSS", exitPrice: candle.close, reason: "EMA21 cruzo EMA55 abajo" };

    // Trailing stop mejorado (v2): activa a 1.2×ATR, mueve SL a entry + 0.3×ATR
    if (!pos.trailingActivated &&
        candle.close >= pos.entryPrice + pos.atrAtEntry * cfg.trailingActivation) {
      const newSL = parseFloat((pos.entryPrice + pos.atrAtEntry * cfg.trailingNewSL).toFixed(4));
      return {
        shouldExit: false, exitType: "TRAILING_STOP",
        exitPrice: 0, reason: `Trailing activo: SL -> ${newSL}`,
        updatedSL: newSL,
      };
    }
  }

  if (pos.direction === "SHORT") {
    if (candle.high >= pos.sl)
      return { shouldExit: true, exitType: "STOP_LOSS", exitPrice: pos.sl, reason: `SL: high ${candle.high.toFixed(2)} >= ${pos.sl.toFixed(2)}` };

    if (candle.low <= pos.tp)
      return { shouldExit: true, exitType: "TAKE_PROFIT", exitPrice: pos.tp, reason: `TP: low ${candle.low.toFixed(2)} <= ${pos.tp.toFixed(2)}` };

    if (!isNaN(rsi) && rsi < cfg.rsiOversold)
      return { shouldExit: true, exitType: "RSI_EXTREME", exitPrice: candle.close, reason: `RSI OS: ${rsi.toFixed(0)} < ${cfg.rsiOversold}` };

    if (![ef, efP, es, esP].some(isNaN) && efP < esP && ef > es)
      return { shouldExit: true, exitType: "EMA_CROSS", exitPrice: candle.close, reason: "EMA21 cruzo EMA55 arriba" };

    if (!pos.trailingActivated &&
        candle.close <= pos.entryPrice - pos.atrAtEntry * cfg.trailingActivation) {
      const newSL = parseFloat((pos.entryPrice - pos.atrAtEntry * cfg.trailingNewSL).toFixed(4));
      return {
        shouldExit: false, exitType: "TRAILING_STOP",
        exitPrice: 0, reason: `Trailing activo: SL -> ${newSL}`,
        updatedSL: newSL,
      };
    }
  }

  return hold;
}

// ─────────────────────────────────────────────────────────────────
// Tamaño de posición con capital compuesto
// ─────────────────────────────────────────────────────────────────

export function calcPositionV2(
  capital:    number,
  entry:      number,
  sl:         number,
  cfg:        CryptoPulseV2Config = DEFAULT_V2_CONFIG
): { posUSDT: number; riskAmt: number; qty: number } {
  const riskAmt  = capital * cfg.riskPerTrade;
  const stopDist = Math.abs(entry - sl);
  if (stopDist === 0) return { posUSDT: 0, riskAmt, qty: 0 };
  const qty     = riskAmt / stopDist;
  const posUSDT = qty * entry;
  return {
    posUSDT:  parseFloat(posUSDT.toFixed(2)),
    riskAmt:  parseFloat(riskAmt.toFixed(2)),
    qty:      parseFloat(qty.toFixed(8)),
  };
}
