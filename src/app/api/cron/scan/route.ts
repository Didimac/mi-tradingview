/**
 * Vercel Cron Job: SmartScorer v3 scan + auto paper trading
 *
 * Runs every 15 min. Scans 8 pairs x 2 timeframes (15m, 1h).
 * Up to 3 concurrent positions on different pairs.
 * SSL Hybrid + RSI Primet as 4th scoring module.
 */

import { NextResponse } from "next/server";
import { fetchKlines } from "@/lib/binance/rest";
import {
  scoreOpportunityDual,
  calcBtcRegime,
  isAlertEligible,
} from "@/lib/scoring/opportunityScorer";
import {
  loadState,
  saveState,
  openPosition,
  checkPriceAction,
  type ScanResult,
} from "@/lib/server/tradingState";

// ─── Constants ───

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
const TIMEFRAMES = ["15m", "1h"] as const;
const COOLDOWN_MS = 45 * 60 * 1000; // 45min per pair

// ─── Telegram helper (direct server-side) ───

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function pctBetween(a: number, b: number): string {
  if (a === 0) return "0.00";
  return (((b - a) / a) * 100).toFixed(2);
}

// ─── Auth check ───

function isAuthorized(req: Request): boolean {
  const envSecret = process.env.CRON_SECRET;

  // Vercel Cron internal header
  if (req.headers.get("x-vercel-cron")) return true;

  // CRON_SECRET via Authorization header or query param
  if (envSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader === `Bearer ${envSecret}`) return true;

    // Also check query param (for cron-job.org which doesn't support custom headers easily)
    const url = new URL(req.url);
    if (url.searchParams.get("secret") === envSecret) return true;

    return false;
  }

  // Development mode
  if (process.env.NODE_ENV === "development") return true;

  return false;
}

// ─── Main handler ───

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const log: string[] = [];
  const events: string[] = [];

  try {
    // 1. Load state from Blob
    let state = await loadState();
    log.push(`State loaded: capital=$${state.capital.toFixed(2)}, positions=${state.positions.length}/3 [${state.positions.map(p => p.symbol).join(",")}], autoMode=${state.autoMode}`);

    // 2. Check all open positions against current prices
    for (const pos of [...state.positions]) {
      try {
        const candles = await fetchKlines(pos.symbol, "15m", 2);
        const lastCandle = candles[candles.length - 1];

        const result = checkPriceAction(state, lastCandle.high, lastCandle.low, lastCandle.close, pos.symbol);

        if (result.event === "tp1_partial") {
          state = result.state;
          const msg = `\u{1F4B0} <b>TP1 PARCIAL — ${pos.symbol.replace("USDT", "")}</b>\n50% cerrado | +${result.pnlPct!.toFixed(2)}%\nSL movido a breakeven\nCapital: $${state.capital.toFixed(2)}`;
          await sendTelegram(msg);
          events.push(`TP1 partial ${pos.symbol}`);
          log.push(`TP1 partial close: ${pos.symbol} +${result.pnlPct!.toFixed(2)}%`);
        } else if (result.event === "tp2_close" || result.event === "sl_close") {
          state = result.state;
          const isWin = result.pnl! >= 0;
          const emoji = isWin ? "\u{2705}" : "\u{1F534}";
          const label = result.event === "tp2_close" ? "TP alcanzado" : "SL tocado";
          const msg = `${emoji} <b>${label} — ${pos.symbol.replace("USDT", "")}</b>\nResultado: ${isWin ? "+" : ""}${result.pnlPct!.toFixed(2)}%\nPosiciones abiertas: ${state.positions.length}\nCapital: $${state.capital.toFixed(2)}`;
          await sendTelegram(msg);
          events.push(`${result.event} ${pos.symbol}`);
          log.push(`Trade closed: ${pos.symbol} ${label} pnl=${result.pnlPct!.toFixed(2)}%`);
        }
      } catch (e) {
        log.push(`Error checking position ${pos.symbol}: ${e}`);
      }
    }

    // 3. Fetch BTC daily for regime
    const btcDaily = await fetchKlines("BTCUSDT", "1d", 210);
    const regime = calcBtcRegime(btcDaily);
    log.push(`BTC regime: ${regime}`);

    // 4. Score all pairs x timeframes (parallel fetch, sequential score)
    const scanResults: ScanResult[] = [];
    const bestByPair: Record<string, { score: Awaited<ReturnType<typeof scoreOpportunityDual>>; tf: string }> = {};

    // Fetch all candles in parallel
    const fetchJobs = PAIRS.flatMap((symbol) =>
      TIMEFRAMES.map((tf) =>
        fetchKlines(symbol, tf, 300)
          .then((candles) => ({ symbol, tf, candles, error: null as string | null }))
          .catch((e) => ({ symbol, tf, candles: [] as Awaited<ReturnType<typeof fetchKlines>>, error: String(e) })),
      ),
    );
    const fetched = await Promise.all(fetchJobs);

    // Score each result
    for (const { symbol, tf, candles, error } of fetched) {
      if (error || candles.length < 60) {
        if (error) log.push(`Error fetching ${symbol}/${tf}: ${error}`);
        continue;
      }
      try {
        const score = await scoreOpportunityDual(symbol, candles, [], regime, state.capital);

        scanResults.push({
          symbol: score.symbol,
          timeframe: tf,
          score: score.score,
          direction: score.direction,
          regime: score.regime,
          components: {
            fundingRate: score.components.fundingRate,
            rsiDivergence: score.components.rsiDivergence,
            vwapWeekly: score.components.vwapWeekly,
            ssl: score.components.ssl,
          },
          entry: score.entry,
          stopLoss: score.stopLoss,
          takeProfit1: score.takeProfit1,
          takeProfit2: score.takeProfit2,
          positionUSDT: score.positionUSDT,
          reason: score.reason,
        });

        log.push(`${symbol}/${tf}: score=${score.score} dir=${score.direction} FR=${score.components.fundingRate} Div=${score.components.rsiDivergence} VWAP=${score.components.vwapWeekly} SSL=${score.components.ssl}`);

        const prev = bestByPair[symbol];
        if (!prev || score.score > prev.score.score) {
          bestByPair[symbol] = { score, tf };
        }
      } catch (e) {
        log.push(`Error scoring ${symbol}/${tf}: ${e}`);
      }
    }

    // 5. Auto-trade: use best score per pair
    if (state.autoMode) {
      const candidates = Object.entries(bestByPair)
        .filter(([, { score }]) => isAlertEligible(score))
        .sort(([, a], [, b]) => b.score.score - a.score.score);

      for (const [symbol, { score, tf }] of candidates) {
        if (state.positions.some((p) => p.symbol === symbol)) continue;

        const lastTime = state.lastSignalTimes[symbol] ?? 0;
        if (Date.now() - lastTime < COOLDOWN_MS) continue;

        const side = score.direction === "LONG" ? "long" : "short";
        const result = openPosition(state, {
          symbol,
          side: side as "long" | "short",
          price: score.entry,
          sl: score.stopLoss,
          tp1: score.takeProfit1,
          tp2: score.takeProfit2,
          reason: `v3 ${tf} | Score ${score.score}/125 | ${score.reason}`,
        });

        if (result.opened) {
          state = result.state;
          state.lastSignalTimes[symbol] = Date.now();

          const sym = symbol.replace("USDT", "");
          const slPct = pctBetween(score.entry, score.stopLoss);
          const tp1Pct = pctBetween(score.entry, score.takeProfit1);
          const tp2Pct = pctBetween(score.entry, score.takeProfit2);

          await sendTelegram([
            `\u{1F4CA} <b>SENAL — ${sym} ${score.direction} (${tf})</b>`,
            `\u{1F916} Entrada auto | Pos ${state.positions.length}/3`,
            ``,
            `Score: ${score.score}/125 | BTC: ${regime}`,
            `─────────────────────────`,
            `Precio:       $${fmtPrice(score.entry)}`,
            `Stop Loss:    $${fmtPrice(score.stopLoss)}  (${slPct}%)`,
            `TP1:          $${fmtPrice(score.takeProfit1)}  (+${tp1Pct}%)`,
            `TP2:          $${fmtPrice(score.takeProfit2)}  (+${tp2Pct}%)`,
            `Lotaje:       $${Math.round(score.positionUSDT)} USDT`,
          ].join("\n"));

          events.push(`AUTO ENTRY: ${side.toUpperCase()} ${symbol} @ ${score.entry} (${tf})`);
          log.push(`Auto-entered ${side} ${symbol} @ ${score.entry} (${tf})`);
        }
      }
    }

    // 6. Save state
    state.lastScanTime = Date.now();
    state.lastScanResults = scanResults;
    await saveState(state);

    const elapsed = Date.now() - startTime;
    log.push(`Scan completed in ${elapsed}ms`);

    return NextResponse.json({
      ok: true,
      elapsed,
      regime,
      scores: scanResults.map((s) => ({
        symbol: s.symbol,
        score: s.score,
        direction: s.direction,
      })),
      positions: state.positions.map((p) => p.symbol),
      positionCount: state.positions.length,
      capital: state.capital,
      autoMode: state.autoMode,
      events,
      log,
    });
  } catch (e) {
    console.error("[Cron] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
