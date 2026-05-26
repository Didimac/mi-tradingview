/**
 * Vercel Cron Job: SmartScorer scan + auto paper trading
 *
 * Runs every 15 min (via vercel.json cron or external trigger).
 * 1. Fetches candles from Binance for BTC/SOL/BNB
 * 2. Runs SmartScorer v2 Variant A
 * 3. Auto-opens paper trade if score >= 75 + autoMode ON
 * 4. Checks open position SL/TP against current price
 * 5. Sends Telegram notifications
 * 6. Persists state to Vercel Blob
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
  type TradingState,
  type ScanResult,
} from "@/lib/server/tradingState";

// ─── Constants ───

const PAIRS = ["BTCUSDT", "SOLUSDT", "BNBUSDT"];
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h per pair

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
  // Vercel Cron sends this header automatically
  const cronSecret = req.headers.get("authorization");
  const envSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is set, verify it
  if (envSecret) {
    return cronSecret === `Bearer ${envSecret}`;
  }

  // Also accept Vercel's internal cron header
  const vercelCron = req.headers.get("x-vercel-cron");
  if (vercelCron) return true;

  // In development, allow all
  if (process.env.NODE_ENV === "development") return true;

  // If no secret configured, allow (user can add CRON_SECRET later for security)
  return true;
}

// ─── Main handler ───

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
    log.push(`State loaded: capital=$${state.capital.toFixed(2)}, position=${state.position?.symbol ?? "none"}, autoMode=${state.autoMode}`);

    // 2. Check open position against current prices FIRST
    if (state.position) {
      const posSymbol = state.position.symbol;
      try {
        const candles = await fetchKlines(posSymbol, "1h", 2);
        const lastCandle = candles[candles.length - 1];

        const result = checkPriceAction(state, lastCandle.high, lastCandle.low, lastCandle.close);

        if (result.event === "tp1_partial") {
          state = result.state;
          const msg = `\u{1F4B0} <b>TP1 PARCIAL — ${posSymbol.replace("USDT", "")}</b>\n50% cerrado | +${result.pnlPct!.toFixed(2)}%\nSL movido a breakeven\nCapital: $${state.capital.toFixed(2)}`;
          await sendTelegram(msg);
          events.push(`TP1 partial ${posSymbol}`);
          log.push(`TP1 partial close: ${posSymbol} +${result.pnlPct!.toFixed(2)}%`);
        } else if (result.event === "tp2_close" || result.event === "sl_close") {
          state = result.state;
          const isWin = result.pnl! >= 0;
          const emoji = isWin ? "\u{2705}" : "\u{1F534}";
          const label = result.event === "tp2_close" ? "TP alcanzado" : "SL tocado";
          const msg = `${emoji} <b>${label} — ${posSymbol.replace("USDT", "")}</b>\nResultado: ${isWin ? "+" : ""}${result.pnlPct!.toFixed(2)}%\nCapital: $${state.capital.toFixed(2)}`;
          await sendTelegram(msg);
          events.push(`${result.event} ${posSymbol}`);
          log.push(`Trade closed: ${posSymbol} ${label} pnl=${result.pnlPct!.toFixed(2)}%`);
        }
      } catch (e) {
        log.push(`Error checking position ${posSymbol}: ${e}`);
      }
    }

    // 3. Fetch BTC daily for regime
    const btcDaily = await fetchKlines("BTCUSDT", "1d", 210);
    const regime = calcBtcRegime(btcDaily);
    log.push(`BTC regime: ${regime}`);

    // 4. Score all pairs
    const scanResults: ScanResult[] = [];

    for (const symbol of PAIRS) {
      try {
        const [c1h, c4h] = await Promise.all([
          fetchKlines(symbol, "1h", 100),
          fetchKlines(symbol, "4h", 100),
        ]);

        const score = await scoreOpportunityDual(symbol, c1h, c4h, regime, state.capital);

        scanResults.push({
          symbol: score.symbol,
          score: score.score,
          direction: score.direction,
          regime: score.regime,
          components: {
            fundingRate: score.components.fundingRate,
            rsiDivergence: score.components.rsiDivergence,
            vwapWeekly: score.components.vwapWeekly,
          },
          entry: score.entry,
          stopLoss: score.stopLoss,
          takeProfit1: score.takeProfit1,
          takeProfit2: score.takeProfit2,
          positionUSDT: score.positionUSDT,
          reason: score.reason,
        });

        log.push(`${symbol}: score=${score.score} dir=${score.direction} FR=${score.components.fundingRate} Div=${score.components.rsiDivergence} VWAP=${score.components.vwapWeekly}`);

        // 5. Auto-trade logic
        if (state.autoMode && isAlertEligible(score) && !state.position) {
          // Check cooldown
          const lastTime = state.lastSignalTimes[symbol] ?? 0;
          if (Date.now() - lastTime >= COOLDOWN_MS) {
            const side = score.direction === "LONG" ? "long" : "short";
            const result = openPosition(state, {
              symbol,
              side: side as "long" | "short",
              price: score.entry,
              sl: score.stopLoss,
              tp1: score.takeProfit1,
              tp2: score.takeProfit2,
              reason: `SmartScorer v2 | Score ${score.score} | ${score.reason}`,
            });

            if (result.opened) {
              state = result.state;
              state.lastSignalTimes[symbol] = Date.now();

              // Send Telegram
              const sym = symbol.replace("USDT", "");
              const slPct = pctBetween(score.entry, score.stopLoss);
              const tp1Pct = pctBetween(score.entry, score.takeProfit1);
              const tp2Pct = pctBetween(score.entry, score.takeProfit2);

              await sendTelegram([
                `\u{1F4CA} <b>SENAL DETECTADA — ${sym} ${score.direction}</b>`,
                `\u{1F916} Entrando automaticamente en paper trading`,
                ``,
                `Score: ${score.score}/100 | BTC: ${regime}`,
                `─────────────────────────`,
                `Precio:       $${fmtPrice(score.entry)}`,
                `Stop Loss:    $${fmtPrice(score.stopLoss)}  (${slPct}%)`,
                `Take Profit 1: $${fmtPrice(score.takeProfit1)}  (+${tp1Pct}%)`,
                `Take Profit 2: $${fmtPrice(score.takeProfit2)}  (+${tp2Pct}%)`,
                `Lotaje:       $${Math.round(score.positionUSDT)} USDT`,
              ].join("\n"));

              await sendTelegram(
                `\u{1F3AF} <b>ENTRADA EJECUTADA — ${sym} ${score.direction}</b>\n\nPrecio: $${fmtPrice(score.entry)}\n\u{23F3} Monitoreando SL/TP cada 15 min...`,
              );

              events.push(`AUTO ENTRY: ${side.toUpperCase()} ${symbol} @ ${score.entry}`);
              log.push(`Auto-entered ${side} ${symbol} @ ${score.entry}`);
            }
          }
        }
      } catch (e) {
        log.push(`Error scoring ${symbol}: ${e}`);
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
      position: state.position?.symbol ?? null,
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
