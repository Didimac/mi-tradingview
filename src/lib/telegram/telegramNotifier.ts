import type { OpportunityScore } from "@/lib/scoring/opportunityScorer";

interface TelegramPayload {
  text: string;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
}

async function sendTelegram(payload: TelegramPayload): Promise<boolean> {
  try {
    const res = await fetch("/api/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

function pctBetween(a: number, b: number): string {
  if (a === 0) return "0.00";
  return (((b - a) / a) * 100).toFixed(2);
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export async function sendSignalAlert(s: OpportunityScore): Promise<boolean> {
  const emoji = s.direction === "LONG" ? "\u{1F7E2}" : "\u{1F534}";
  const regimeLabel = s.regime === "BULL" ? "ALCISTA" : "BAJISTA";

  const slPct = pctBetween(s.entry, s.stopLoss);
  const tp1Pct = pctBetween(s.entry, s.takeProfit1);
  const tp2Pct = pctBetween(s.entry, s.takeProfit2);

  const text = [
    `${emoji} <b>SENAL FUERTE — ${s.symbol.replace("USDT", "")} ${s.direction}</b>`,
    `Score: ${s.score}/100 (1H: ${s.score1H} | 4H: ${s.score4H}) | Regimen BTC: ${regimeLabel}`,
    `Precio: $${fmtPrice(s.entry)} | Lotaje: $${fmtPrice(s.positionUSDT)} USDT`,
    `Stop Loss: $${fmtPrice(s.stopLoss)} (${slPct}%)`,
    `Take Profit 1: $${fmtPrice(s.takeProfit1)} (+${tp1Pct}%) \u{2192} cerrar 50%`,
    `Take Profit 2: $${fmtPrice(s.takeProfit2)} (+${tp2Pct}%) \u{2192} cerrar 50% restante`,
  ].join("\n");

  // Compact timestamp: minutes since 2025-01-01 (fits in fewer digits)
  const nowMs = Date.now();
  const epoch = new Date("2025-01-01").getTime();
  const tMin = Math.floor((nowMs - epoch) / 60000);

  // Compact prices: multiply by 100 and round to avoid decimals
  const p = (n: number) => Math.round(n * 100);
  const sym = s.symbol.replace("USDT", "");

  const execData = `x:${sym}:${s.direction[0]}:${p(s.entry)}:${p(s.stopLoss)}:${p(s.takeProfit1)}:${p(s.takeProfit2)}:${p(s.qty * 100)}:${tMin}`;
  const ignoreData = `i:${sym}:${tMin}`;

  return sendTelegram({
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "\u{2705} Ejecutar orden", callback_data: execData },
          { text: "\u{274C} Ignorar", callback_data: ignoreData },
        ],
      ],
    },
  });
}

export async function sendTradeResult(
  symbol: string,
  exitReason: string,
  pnlPct: number,
  newCapital: number,
): Promise<boolean> {
  const emoji = pnlPct >= 0 ? "\u{2705}" : "\u{1F534}";
  const label = exitReason.includes("TP") || exitReason.includes("Profit")
    ? "TP alcanzado"
    : "SL tocado";

  return sendTelegram({
    text: [
      `${emoji} <b>${label} — ${symbol.replace("USDT", "")}</b>`,
      `Resultado: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | Capital: $${newCapital.toFixed(2)}`,
    ].join("\n"),
  });
}

export async function sendDailySummary(
  trades: number,
  netPnl: number,
  capital: number,
): Promise<boolean> {
  return sendTelegram({
    text: [
      `\u{1F4CA} <b>Resumen diario</b>`,
      `Trades: ${trades} | Resultado neto: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`,
      `Capital actual: $${capital.toFixed(2)}`,
    ].join("\n"),
  });
}

export async function sendTestMessage(): Promise<boolean> {
  return sendTelegram({
    text: "\u{1F916} <b>Test de conexion</b>\nTelegram conectado correctamente a mi-tradingview.",
  });
}
