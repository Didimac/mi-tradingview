/**
 * Backtest: SSL Hybrid + EMA200 + RSI Primet Strategy
 *
 * Tests across multiple pairs and timeframes to find optimal combinations.
 * Uses Binance historical data (data-api.binance.vision).
 *
 * Run: npx tsx scripts/backtest-ssl-strategy.ts
 */

// ─── Types ───

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  timeframe: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPct: number;
  exitReason: string;
}

interface BacktestResult {
  symbol: string;
  timeframe: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlPct: number;
  maxDrawdown: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  finalCapital: number;
  sharpe: number;
}

// ─── Config ───

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
const TIMEFRAMES = ["15m", "1h", "4h", "1d"];
const START_CAPITAL = 1000;
const RISK_PER_TRADE = 0.015; // 1.5%
const ATR_SL_MULT = 1.5;
const ATR_TP1_MULT = 2.25;
const ATR_TP2_MULT = 4.5;

// SSL Strategy params
const SSL_BASELINE = 65;
const RSI_LEN = 35;
const RSI_SMOOTH = 5;
const EMA200_PERIOD = 200;

const BASE_URL = "https://data-api.binance.vision/api/v3";

// ─── Fetch Functions ───

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status} for ${symbol} ${interval}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function fetchKlinesBefore(symbol: string, interval: string, endTimeMs: number, limit: number): Promise<Candle[]> {
  const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&endTime=${endTimeMs - 1}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function fetchAllCandles(symbol: string, interval: string): Promise<Candle[]> {
  // Fetch max candles (about 2 years depending on timeframe)
  let candles = await fetchKlines(symbol, interval, 1000);

  // Fetch more batches to get ~2 years of data
  const batches = interval === "15m" ? 6 : interval === "1h" ? 4 : interval === "4h" ? 2 : 1;

  for (let i = 0; i < batches; i++) {
    if (candles.length === 0) break;
    const oldest = candles[0].time * 1000;
    const older = await fetchKlinesBefore(symbol, interval, oldest, 1000);
    if (older.length === 0) break;
    candles = [...older, ...candles];
    await sleep(200); // Rate limit
  }

  return candles;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Indicator Functions ───

function smaArray(data: number[], period: number): number[] {
  const out = new Array(data.length).fill(NaN);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function emaArray(data: number[], period: number): number[] {
  const out = new Array(data.length).fill(NaN);
  if (data.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += data[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function calcATR(candles: Candle[], period = 14): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr;
  }
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function calcRSI(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// ─── SSL Hybrid Calculation ───

interface SSLState {
  direction: 1 | -1;
  sslUp: number;
  sslDown: number;
}

function calcSSL(candles: Candle[], baseline: number): SSLState[] {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const sslHigh = smaArray(highs, baseline);
  const sslLow = smaArray(lows, baseline);

  const out: SSLState[] = new Array(candles.length);
  let hlv = 0;
  for (let i = 0; i < candles.length; i++) {
    if (isNaN(sslHigh[i]) || isNaN(sslLow[i])) {
      out[i] = { direction: 1, sslUp: NaN, sslDown: NaN };
      continue;
    }
    if (closes[i] > sslHigh[i]) hlv = 1;
    else if (closes[i] < sslLow[i]) hlv = -1;
    const dir = (hlv || 1) as 1 | -1;
    out[i] = {
      direction: dir,
      sslUp: dir < 0 ? sslLow[i] : sslHigh[i] > sslLow[i] ? sslHigh[i] : sslLow[i],
      sslDown: dir < 0 ? sslHigh[i] : sslLow[i],
    };
  }
  return out;
}

// ─── RSI Primet (Heikin Ashi) ───

function calcRSIPrimet(closes: number[], rsiLen: number, smooth: number): boolean[] {
  const n = closes.length;
  const rsiArr = calcRSI(closes, rsiLen);

  // Build HA candles from RSI
  const haClose = new Array(n).fill(NaN);
  const haOpen = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (isNaN(rsiArr[i])) continue;
    const rC = rsiArr[i];
    const rO = i > 0 && !isNaN(rsiArr[i - 1]) ? rsiArr[i - 1] : rC;
    const rH = Math.max(rC, rO);
    const rL = Math.min(rC, rO);
    haClose[i] = (rO + rH + rL + rC) / 4;
    haOpen[i] = i > 0 && !isNaN(haOpen[i - 1]) && !isNaN(haClose[i - 1])
      ? (haOpen[i - 1] + haClose[i - 1]) / 2
      : (rO + rC) / 2;
  }

  const smClose = emaArray(haClose.map((v: number) => isNaN(v) ? 0 : v), smooth);
  const smOpen = emaArray(haOpen.map((v: number) => isNaN(v) ? 0 : v), smooth);

  // true = green (bullish)
  return closes.map((_, i) => {
    if (isNaN(smClose[i]) || isNaN(smOpen[i]) || isNaN(rsiArr[i])) return false;
    return smClose[i] >= smOpen[i];
  });
}

// ─── Strategy Signal Generator ───

interface Signal {
  index: number;
  type: "BUY" | "SELL";
  price: number;
}

function generateSignals(candles: Candle[]): Signal[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const minRequired = Math.max(EMA200_PERIOD, SSL_BASELINE, RSI_LEN + RSI_SMOOTH) + 10;
  if (n < minRequired) return [];

  const ema200 = emaArray(closes, EMA200_PERIOD);
  const ssl = calcSSL(candles, SSL_BASELINE);
  const rsiGreen = calcRSIPrimet(closes, RSI_LEN, RSI_SMOOTH);

  const signals: Signal[] = [];
  let lastDir = 0;

  // Track changes
  let prevSslDir = 0;
  let prevRsiGreen = false;
  let barsSinceSslBull = 999, barsSinceSslBear = 999;
  let barsSinceRsiBull = 999, barsSinceRsiBear = 999;

  for (let i = 0; i < n; i++) {
    if (isNaN(ema200[i]) || isNaN(ssl[i].sslUp)) {
      prevSslDir = ssl[i].direction;
      prevRsiGreen = rsiGreen[i];
      continue;
    }

    // SSL direction change detection
    if (ssl[i].direction === 1 && prevSslDir !== 1) barsSinceSslBull = 0;
    else barsSinceSslBull++;
    if (ssl[i].direction === -1 && prevSslDir !== -1) barsSinceSslBear = 0;
    else barsSinceSslBear++;

    // RSI Primet color change detection
    if (rsiGreen[i] && !prevRsiGreen) barsSinceRsiBull = 0;
    else barsSinceRsiBull++;
    if (!rsiGreen[i] && prevRsiGreen) barsSinceRsiBear = 0;
    else barsSinceRsiBear++;

    prevSslDir = ssl[i].direction;
    prevRsiGreen = rsiGreen[i];

    const price = closes[i];
    const priceBull = price > ema200[i];
    const priceBear = price < ema200[i];

    if (priceBull && barsSinceSslBull <= 3 && barsSinceRsiBull <= 3 && rsiGreen[i] && lastDir !== 1) {
      signals.push({ index: i, type: "BUY", price: candles[i].close });
      lastDir = 1;
    }

    if (priceBear && barsSinceSslBear <= 3 && barsSinceRsiBear <= 3 && !rsiGreen[i] && lastDir !== -1) {
      signals.push({ index: i, type: "SELL", price: candles[i].close });
      lastDir = -1;
    }
  }

  return signals;
}

// ─── Backtest Engine ───

function runBacktest(candles: Candle[], symbol: string, timeframe: string): BacktestResult {
  const signals = generateSignals(candles);
  const atr = calcATR(candles, 14);
  const trades: Trade[] = [];
  let capital = START_CAPITAL;
  let peak = START_CAPITAL;
  let maxDD = 0;

  for (const signal of signals) {
    const i = signal.index;
    const atrVal = atr[i];
    if (isNaN(atrVal) || atrVal <= 0) continue;

    const entry = signal.price;
    let sl: number, tp1: number, tp2: number;

    if (signal.type === "BUY") {
      sl = entry - ATR_SL_MULT * atrVal;
      tp1 = entry + ATR_TP1_MULT * atrVal;
      tp2 = entry + ATR_TP2_MULT * atrVal;
    } else {
      sl = entry + ATR_SL_MULT * atrVal;
      tp1 = entry - ATR_TP1_MULT * atrVal;
      tp2 = entry - ATR_TP2_MULT * atrVal;
    }

    // Risk-based position sizing
    const riskAmt = capital * RISK_PER_TRADE;
    const slDist = Math.abs(entry - sl);
    if (slDist === 0) continue;
    const qty = riskAmt / slDist;

    // Simulate trade execution on future candles
    let exitPrice = 0;
    let exitReason = "";
    let exitTime = 0;
    let partialPnl = 0;
    let partialClosed = false;
    let currentSl = sl;
    let remainingQty = qty;

    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];

      if (signal.type === "BUY") {
        // SL check
        if (c.low <= currentSl) {
          exitPrice = currentSl;
          exitReason = partialClosed ? "SL (breakeven)" : "Stop Loss";
          exitTime = c.time;
          break;
        }
        // TP1 partial
        if (!partialClosed && c.high >= tp1) {
          const closedQty = qty * 0.5;
          partialPnl = (tp1 - entry) * closedQty;
          remainingQty = qty - closedQty;
          currentSl = entry; // breakeven
          partialClosed = true;
        }
        // TP2 full
        if (partialClosed && c.high >= tp2) {
          exitPrice = tp2;
          exitReason = "Take Profit 2";
          exitTime = c.time;
          break;
        }
      } else {
        // SHORT
        if (c.high >= currentSl) {
          exitPrice = currentSl;
          exitReason = partialClosed ? "SL (breakeven)" : "Stop Loss";
          exitTime = c.time;
          break;
        }
        if (!partialClosed && c.low <= tp1) {
          const closedQty = qty * 0.5;
          partialPnl = (entry - tp1) * closedQty;
          remainingQty = qty - closedQty;
          currentSl = entry;
          partialClosed = true;
        }
        if (partialClosed && c.low <= tp2) {
          exitPrice = tp2;
          exitReason = "Take Profit 2";
          exitTime = c.time;
          break;
        }
      }

      // Max hold: exit at last candle
      if (j === candles.length - 1) {
        exitPrice = c.close;
        exitReason = "Timeout";
        exitTime = c.time;
        break;
      }
    }

    if (exitPrice === 0) continue;

    // Calculate final PnL
    let finalPnl: number;
    if (signal.type === "BUY") {
      finalPnl = partialPnl + (exitPrice - entry) * remainingQty;
    } else {
      finalPnl = partialPnl + (entry - exitPrice) * remainingQty;
    }

    const pnlPct = (finalPnl / capital) * 100;
    capital += finalPnl;

    trades.push({
      symbol,
      timeframe,
      side: signal.type,
      entryPrice: entry,
      exitPrice,
      entryTime: candles[i].time,
      exitTime,
      pnlPct,
      exitReason,
    });

    // Track drawdown
    if (capital > peak) peak = capital;
    const dd = ((peak - capital) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Calculate stats
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const totalWinPct = wins.reduce((s, t) => s + t.pnlPct, 0);
  const totalLossPct = losses.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
  const profitFactor = totalLossPct === 0 ? (totalWinPct > 0 ? 999 : 0) : totalWinPct / totalLossPct;
  const avgWin = wins.length > 0 ? totalWinPct / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPct / losses.length : 0;

  // Sharpe ratio (simplified)
  const returns = trades.map((t) => t.pnlPct);
  const meanRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanRet / stdDev) * Math.sqrt(returns.length) : 0;

  return {
    symbol,
    timeframe,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnlPct: ((capital - START_CAPITAL) / START_CAPITAL) * 100,
    maxDrawdown: maxDD,
    profitFactor,
    avgWin,
    avgLoss,
    finalCapital: capital,
    sharpe,
  };
}

// ─── Main ───

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST: SSL Hybrid + EMA200 + RSI Primet Strategy");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Capital: €${START_CAPITAL} | Risk: ${RISK_PER_TRADE * 100}% per trade`);
  console.log(`  SSL Baseline: ${SSL_BASELINE} | RSI Len: ${RSI_LEN} | RSI Smooth: ${RSI_SMOOTH}`);
  console.log(`  SL: ${ATR_SL_MULT}x ATR | TP1: ${ATR_TP1_MULT}x ATR | TP2: ${ATR_TP2_MULT}x ATR`);
  console.log(`  Pares: ${PAIRS.join(", ")}`);
  console.log(`  Temporalidades: ${TIMEFRAMES.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: BacktestResult[] = [];

  for (const tf of TIMEFRAMES) {
    console.log(`\n▶ Temporalidad: ${tf}`);
    console.log("─".repeat(60));

    for (const pair of PAIRS) {
      process.stdout.write(`  ${pair.padEnd(10)} ... `);
      try {
        const candles = await fetchAllCandles(pair, tf);
        const result = runBacktest(candles, pair, tf);
        results.push(result);

        const emoji = result.totalPnlPct > 0 ? "✅" : result.totalPnlPct > -5 ? "⚠️" : "❌";
        console.log(
          `${emoji} ${result.totalTrades} trades | WR ${result.winRate.toFixed(0)}% | ` +
          `PnL ${result.totalPnlPct >= 0 ? "+" : ""}${result.totalPnlPct.toFixed(1)}% | ` +
          `PF ${result.profitFactor.toFixed(2)} | DD ${result.maxDrawdown.toFixed(1)}% | ` +
          `€${result.finalCapital.toFixed(0)} | ${candles.length} velas`
        );
        await sleep(300);
      } catch (e) {
        console.log(`❌ Error: ${e}`);
      }
    }
  }

  // ─── Rankings ───

  console.log("\n\n");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RANKING POR RENTABILIDAD (Top 15)");
  console.log("═══════════════════════════════════════════════════════════════");

  const sorted = [...results]
    .filter((r) => r.totalTrades >= 5)
    .sort((a, b) => b.totalPnlPct - a.totalPnlPct);

  console.log(
    "  #  Par        TF     Trades  WR%   PnL%     PF    DD%   Sharpe  Capital"
  );
  console.log("  " + "─".repeat(76));

  sorted.slice(0, 15).forEach((r, i) => {
    const emoji = r.totalPnlPct > 0 ? "✅" : "❌";
    console.log(
      `  ${String(i + 1).padStart(2)}. ${emoji} ${r.symbol.padEnd(10)} ${r.timeframe.padEnd(4)}   ` +
      `${String(r.totalTrades).padStart(5)}  ${r.winRate.toFixed(0).padStart(3)}%  ` +
      `${(r.totalPnlPct >= 0 ? "+" : "") + r.totalPnlPct.toFixed(1) + "%"}`.padStart(8) + "  " +
      `${r.profitFactor.toFixed(2).padStart(5)}  ${r.maxDrawdown.toFixed(1).padStart(5)}%  ` +
      `${r.sharpe.toFixed(2).padStart(6)}  €${r.finalCapital.toFixed(0)}`
    );
  });

  // ─── Best per timeframe ───

  console.log("\n\n");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MEJOR PAR POR TEMPORALIDAD");
  console.log("═══════════════════════════════════════════════════════════════");

  for (const tf of TIMEFRAMES) {
    const tfResults = results.filter((r) => r.timeframe === tf && r.totalTrades >= 3);
    if (tfResults.length === 0) continue;
    const best = tfResults.sort((a, b) => b.totalPnlPct - a.totalPnlPct)[0];
    const emoji = best.totalPnlPct > 0 ? "🏆" : "⚠️";
    console.log(
      `  ${emoji} ${tf.padEnd(4)} → ${best.symbol.padEnd(10)} | ` +
      `${best.totalTrades} trades | WR ${best.winRate.toFixed(0)}% | ` +
      `PnL ${best.totalPnlPct >= 0 ? "+" : ""}${best.totalPnlPct.toFixed(1)}% | ` +
      `PF ${best.profitFactor.toFixed(2)} | DD ${best.maxDrawdown.toFixed(1)}%`
    );
  }

  // ─── Best per pair ───

  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MEJOR TEMPORALIDAD POR PAR");
  console.log("═══════════════════════════════════════════════════════════════");

  for (const pair of PAIRS) {
    const pairResults = results.filter((r) => r.symbol === pair && r.totalTrades >= 3);
    if (pairResults.length === 0) continue;
    const best = pairResults.sort((a, b) => b.totalPnlPct - a.totalPnlPct)[0];
    const emoji = best.totalPnlPct > 0 ? "🏆" : "⚠️";
    console.log(
      `  ${emoji} ${pair.padEnd(10)} → ${best.timeframe.padEnd(4)} | ` +
      `${best.totalTrades} trades | WR ${best.winRate.toFixed(0)}% | ` +
      `PnL ${best.totalPnlPct >= 0 ? "+" : ""}${best.totalPnlPct.toFixed(1)}% | ` +
      `PF ${best.profitFactor.toFixed(2)}`
    );
  }

  // ─── Summary ───

  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RESUMEN GENERAL");
  console.log("═══════════════════════════════════════════════════════════════");

  const profitable = results.filter((r) => r.totalPnlPct > 0 && r.totalTrades >= 5);
  const unprofitable = results.filter((r) => r.totalPnlPct <= 0 && r.totalTrades >= 5);

  console.log(`  Total combinaciones testeadas: ${results.length}`);
  console.log(`  Rentables (>0%):  ${profitable.length} de ${profitable.length + unprofitable.length}`);
  console.log(`  No rentables:     ${unprofitable.length}`);

  if (sorted.length > 0) {
    const best = sorted[0];
    console.log(`\n  🏆 MEJOR COMBINACIÓN: ${best.symbol} en ${best.timeframe}`);
    console.log(`     ${best.totalTrades} trades | WR ${best.winRate.toFixed(0)}% | PnL +${best.totalPnlPct.toFixed(1)}%`);
    console.log(`     PF ${best.profitFactor.toFixed(2)} | Max DD ${best.maxDrawdown.toFixed(1)}%`);
    console.log(`     €${START_CAPITAL} → €${best.finalCapital.toFixed(0)}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
