// Quick backtest runner for Crypto Pulse strategy
// Usage: node scripts/run-backtest.mjs

const BASE = "https://api.binance.com/api/v3";

// ── Fetch helpers ──────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 1000) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchKlinesBefore(symbol, interval, endTimeMs, limit = 1000) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&endTime=${endTimeMs - 1}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function loadCandles(symbol, timeframe, count) {
  let candles = await fetchKlines(symbol, timeframe, Math.min(count, 1000));
  while (candles.length < count) {
    const oldest = candles[0];
    const batch = await fetchKlinesBefore(symbol, timeframe, oldest.time * 1000, Math.min(count - candles.length, 1000));
    if (batch.length === 0) break;
    candles = [...batch, ...candles];
  }
  const seen = new Set();
  candles = candles.sort((a, b) => a.time - b.time).filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
  return candles;
}

// ── Indicators ─────────────────────────────────────────────────

function calcEMA(candles, period) {
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

function calcRSI(candles, period) {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  }
  return result;
}

function calcATR(candles, period) {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  result[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result[i + 1] = atr;
  }
  return result;
}

// ── Config ─────────────────────────────────────────────────────

const CONFIG = {
  emaFast: 21, emaSlow: 55, rsiPeriod: 14, atrPeriod: 14, volumeLookback: 20,
  trendSeparationPct: 0.3, atrSlMultiplier: 1.5, atrTpMultiplier: 3.0,
  volumeMultiplierTrend: 1.5, volumeMultiplierRange: 1.2,
  rsiOverbought: 78, rsiOversold: 22, rsiMidCrossMin: 48, rsiMidCrossMax: 52,
  rsiRangeLong: 35, rsiRangeShort: 65, riskPerTrade: 0.015, maxOpenPositions: 3,
};

// ── Helpers ────────────────────────────────────────────────────

function avgVolume(candles, idx, lookback) {
  const start = Math.max(1, idx - lookback);
  const slice = candles.slice(start, idx);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

function isBullishEngulfing(prev, curr) {
  return prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close;
}

function isBearishEngulfing(prev, curr) {
  return prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close;
}

function precompute(candles) {
  return {
    emaFastArr: calcEMA(candles, CONFIG.emaFast),
    emaSlowArr: calcEMA(candles, CONFIG.emaSlow),
    rsiArr: calcRSI(candles, CONFIG.rsiPeriod),
    atrArr: calcATR(candles, CONFIG.atrPeriod),
  };
}

function evaluateBar(candles, ind, i) {
  const minIdx = Math.max(CONFIG.emaSlow, CONFIG.rsiPeriod, CONFIG.atrPeriod) + 2;
  if (i < minIdx) return { signal: "NONE" };
  const ef = ind.emaFastArr[i], es = ind.emaSlowArr[i], rsi = ind.rsiArr[i], rsiP = ind.rsiArr[i-1], atr = ind.atrArr[i];
  if (isNaN(ef)||isNaN(es)||isNaN(rsi)||isNaN(atr)||atr===0) return { signal: "NONE" };
  const c = candles[i], pc = candles[i-1], close = c.close;
  const sepPct = Math.abs(ef - es) / es * 100;
  const regime = sepPct >= CONFIG.trendSeparationPct ? "TREND" : "RANGE";
  const volAvg = avgVolume(candles, i, CONFIG.volumeLookback);
  const volMult = regime === "TREND" ? CONFIG.volumeMultiplierTrend : CONFIG.volumeMultiplierRange;
  const volOk = volAvg > 0 && c.volume >= volAvg * volMult;
  const slD = atr * CONFIG.atrSlMultiplier, tpD = atr * CONFIG.atrTpMultiplier;

  if (regime === "TREND") {
    if (ef > es && rsiP < CONFIG.rsiMidCrossMin && rsi >= CONFIG.rsiMidCrossMax && close > ef && volOk)
      return { signal: "LONG", entry: close, sl: close - slD, tp: close + tpD, atr, reason: "TREND LONG" };
    if (ef < es && rsiP > CONFIG.rsiMidCrossMax && rsi <= CONFIG.rsiMidCrossMin && close < ef && volOk)
      return { signal: "SHORT", entry: close, sl: close + slD, tp: close - tpD, atr, reason: "TREND SHORT" };
  }
  if (regime === "RANGE") {
    const touchLow = Math.abs(c.low - es) / es < 0.005, aboveEma = close > es;
    if (rsiP <= CONFIG.rsiRangeLong && rsi > rsiP && (touchLow || aboveEma) && (isBullishEngulfing(pc, c) || volOk))
      return { signal: "LONG", entry: close, sl: close - slD, tp: close + tpD, atr, reason: "RANGE LONG" };
    const touchHigh = Math.abs(c.high - es) / es < 0.005, belowEma = close < es;
    if (rsiP >= CONFIG.rsiRangeShort && rsi < rsiP && (touchHigh || belowEma) && (isBearishEngulfing(pc, c) || volOk))
      return { signal: "SHORT", entry: close, sl: close + slD, tp: close - tpD, atr, reason: "RANGE SHORT" };
  }
  return { signal: "NONE" };
}

function checkExit(c, pos, ind, i) {
  const rsi = ind.rsiArr[i], ef = ind.emaFastArr[i], efP = ind.emaFastArr[i-1], es = ind.emaSlowArr[i], esP = ind.emaSlowArr[i-1];
  if (pos.side === "long") {
    if (c.low <= pos.sl) return { exit: true, price: pos.sl, reason: "SL" };
    if (c.high >= pos.tp) return { exit: true, price: pos.tp, reason: "TP" };
    if (!isNaN(rsi) && rsi > CONFIG.rsiOverbought) return { exit: true, price: c.close, reason: "RSI OB" };
    if (!isNaN(ef) && !isNaN(es) && !isNaN(efP) && !isNaN(esP) && efP > esP && ef < es) return { exit: true, price: c.close, reason: "EMA cross" };
    if (!pos.trailing && c.close >= pos.entry + pos.atr) return { exit: false, newSL: pos.entry };
  } else {
    if (c.high >= pos.sl) return { exit: true, price: pos.sl, reason: "SL" };
    if (c.low <= pos.tp) return { exit: true, price: pos.tp, reason: "TP" };
    if (!isNaN(rsi) && rsi < CONFIG.rsiOversold) return { exit: true, price: c.close, reason: "RSI OS" };
    if (!isNaN(ef) && !isNaN(es) && !isNaN(efP) && !isNaN(esP) && efP < esP && ef > es) return { exit: true, price: c.close, reason: "EMA cross" };
    if (!pos.trailing && c.close <= pos.entry - pos.atr) return { exit: false, newSL: pos.entry };
  }
  return { exit: false };
}

// ── Backtest runner ────────────────────────────────────────────

function runBacktest(candles, startEquity = 10000) {
  const ind = precompute(candles);
  const trades = [];
  let cash = startEquity, peak = cash, pos = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const ex = checkExit(c, pos, ind, i);
      if (ex.newSL !== undefined && !ex.exit) { pos.sl = ex.newSL; pos.trailing = true; }
      else if (ex.exit) {
        let pnl = pos.side === "long"
          ? ((ex.price - pos.entry) / pos.entry) * cash
          : ((pos.entry - ex.price) / pos.entry) * cash;
        cash += pnl;
        trades.push({ side: pos.side, entry: pos.entry, exitPrice: ex.price, pnl, pnlPct: (pnl / (cash - pnl)) * 100, reason: ex.reason, bars: i - pos.idx });
        if (cash > peak) peak = cash;
        pos = null;
      }
    }
    if (!pos) {
      const ev = evaluateBar(candles, ind, i);
      if (ev.signal !== "NONE") {
        pos = { side: ev.signal === "LONG" ? "long" : "short", entry: ev.entry, sl: ev.sl, tp: ev.tp, atr: ev.atr, idx: i, trailing: false };
      }
    }
  }
  // Close remaining
  if (pos) {
    const last = candles[candles.length - 1];
    let pnl = pos.side === "long"
      ? ((last.close - pos.entry) / pos.entry) * cash
      : ((pos.entry - last.close) / pos.entry) * cash;
    cash += pnl;
    trades.push({ side: pos.side, entry: pos.entry, exitPrice: last.close, pnl, pnlPct: (pnl / (cash - pnl)) * 100, reason: "EOD", bars: candles.length - 1 - pos.idx });
  }

  // Metrics
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Max drawdown
  let equity = startEquity, eqPeak = startEquity, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > eqPeak) eqPeak = equity;
    const dd = ((eqPeak - equity) / eqPeak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "0.00",
    totalReturn: ((cash - startEquity) / startEquity * 100).toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    finalEquity: cash.toFixed(2),
  };
}

// ── Main ───────────────────────────────────────────────────────

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
// 1 year of 4H = 365 * 6 = 2190 candles
const CANDLE_COUNT = 2190;

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║  Crypto Pulse Backtest — 1 año · 4H · Capital: $10,000         ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

for (const pair of PAIRS) {
  process.stdout.write(`⏳ ${pair} — cargando ${CANDLE_COUNT} velas...`);
  try {
    const candles = await loadCandles(pair, "4h", CANDLE_COUNT);
    process.stdout.write(` ${candles.length} cargadas. Ejecutando...\n`);

    const result = runBacktest(candles);

    const dateFrom = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
    const dateTo = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);

    console.log(`\n┌─── ${pair} (${dateFrom} → ${dateTo}) ───`);
    console.log(`│  Total Trades:   ${result.totalTrades}`);
    console.log(`│  Win Rate:       ${result.winRate}%`);
    console.log(`│  Profit Factor:  ${result.profitFactor}`);
    console.log(`│  Retorno Total:  ${result.totalReturn}%`);
    console.log(`│  Max Drawdown:   ${result.maxDrawdown}%`);
    console.log(`│  Equity Final:   $${result.finalEquity}`);
    console.log(`└${"─".repeat(50)}\n`);
  } catch (err) {
    console.log(` ERROR: ${err.message}\n`);
  }
}
