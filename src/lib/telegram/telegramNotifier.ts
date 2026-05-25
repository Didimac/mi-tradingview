import type { OpportunityScore } from "@/lib/scoring/opportunityScorer";

interface TelegramPayload {
  text: string;
  reply_markup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
}

interface TelegramResponse {
  ok: boolean;
  message_id?: number;
}

async function sendTelegram(payload: TelegramPayload): Promise<TelegramResponse> {
  try {
    const res = await fetch("/api/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return { ok: data.ok === true, message_id: data.message_id };
  } catch {
    return { ok: false };
  }
}

export function pctBetween(a: number, b: number): string {
  if (a === 0) return "0.00";
  return (((b - a) / a) * 100).toFixed(2);
}

export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

// ─── FASE 1: Oportunidad detectada (informativo, sin botones) ───

export async function sendPhase1Alert(s: OpportunityScore): Promise<{ ok: boolean; messageId?: number }> {
  const regimeEmoji = s.regime === "BULL" ? "\u{1F7E2}" : "\u{1F534}";
  const sym = s.symbol.replace("USDT", "");

  const slPct = pctBetween(s.entry, s.stopLoss);
  const tp1Pct = pctBetween(s.entry, s.takeProfit1);
  const tp2Pct = pctBetween(s.entry, s.takeProfit2);

  const entryType = s.entryZone.type === "Retroceso a EMA21"
    ? "esperar retroceso"
    : s.entryZone.type === "Entrada tardia"
      ? "precio alejado"
      : "momentum";

  const text = [
    `\u{1F4CA} <b>OPORTUNIDAD DETECTADA \u{2014} ${sym} ${s.direction}</b>`,
    `Score: ${s.score}/100 | BTC: ${s.regime} ${regimeEmoji}`,
    `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}`,
    `Precio actual:    $${fmtPrice(s.entry)}`,
    `Entrada ideal:    $${fmtPrice(s.entryZone.ideal)}  (${entryType})`,
    `Entrada maxima:   $${fmtPrice(s.entryZone.latest)}  (no entrar por encima)`,
    `Stop Loss:        $${fmtPrice(s.stopLoss)}  (${slPct}%)`,
    `Take Profit 1:    $${fmtPrice(s.takeProfit1)}  (+${tp1Pct}%)`,
    `Take Profit 2:    $${fmtPrice(s.takeProfit2)}  (+${tp2Pct}%)`,
    `Lotaje sugerido:  $${Math.round(s.positionUSDT)} USDT`,
    `\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}`,
    `\u{23F3} Vigilando precio para alerta de entrada...`,
  ].join("\n");

  const result = await sendTelegram({ text });
  return { ok: result.ok, messageId: result.message_id };
}

// ─── FASE 2: Entrar ahora (con botones) ───

export async function sendPhase2Alert(
  s: OpportunityScore,
  currentPrice: number,
): Promise<{ ok: boolean; messageId?: number }> {
  const sym = s.symbol.replace("USDT", "");
  const slPct = pctBetween(currentPrice, s.stopLoss);
  const tp1Pct = pctBetween(currentPrice, s.takeProfit1);
  const tp2Pct = pctBetween(currentPrice, s.takeProfit2);

  const text = [
    `\u{1F3AF} <b>ENTRAR AHORA \u{2014} ${sym} ${s.direction}</b>`,
    ``,
    `Precio actual:  $${fmtPrice(currentPrice)}  \u{2705} Zona ideal`,
    `Stop Loss:      $${fmtPrice(s.stopLoss)}  (${slPct}%)`,
    `Take Profit 1:  $${fmtPrice(s.takeProfit1)}  (+${tp1Pct}%)`,
    `Take Profit 2:  $${fmtPrice(s.takeProfit2)}  (+${tp2Pct}%)`,
    `Lotaje:         $${Math.round(s.positionUSDT)} USDT`,
  ].join("\n");

  // Compact timestamp
  const epoch = new Date("2025-01-01").getTime();
  const tMin = Math.floor((Date.now() - epoch) / 60000);
  const p = (n: number) => Math.round(n * 100);

  const execData = `x:${sym}:${s.direction[0]}:${p(currentPrice)}:${p(s.stopLoss)}:${p(s.takeProfit1)}:${p(s.takeProfit2)}:${p(s.qty * 100)}:${tMin}`;
  const ignoreData = `i:${sym}:${tMin}`;

  const result = await sendTelegram({
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
  return { ok: result.ok, messageId: result.message_id };
}

// ─── Status update messages ───

export async function sendOpportunityExpired(symbol: string): Promise<boolean> {
  const sym = symbol.replace("USDT", "");
  const result = await sendTelegram({
    text: `\u{23F0} <b>${sym} \u{2014} Oportunidad expirada</b> (2h sin entrada)`,
  });
  return result.ok;
}

export async function sendPriceEscaped(symbol: string): Promise<boolean> {
  const sym = symbol.replace("USDT", "");
  const result = await sendTelegram({
    text: `\u{1F680} <b>${sym} \u{2014} Precio escapo sin retroceso.</b>\nEsperar proxima oportunidad.`,
  });
  return result.ok;
}

export async function sendSignalCancelled(symbol: string, currentScore: number): Promise<boolean> {
  const sym = symbol.replace("USDT", "");
  const result = await sendTelegram({
    text: `\u{274C} <b>${sym} \u{2014} Senal cancelada</b> (score bajo a ${currentScore})`,
  });
  return result.ok;
}

// Legacy alias for backward compatibility
export async function sendSignalAlert(s: OpportunityScore): Promise<boolean> {
  const result = await sendPhase1Alert(s);
  return result.ok;
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

  const result = await sendTelegram({
    text: [
      `${emoji} <b>${label} — ${symbol.replace("USDT", "")}</b>`,
      `Resultado: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | Capital: $${newCapital.toFixed(2)}`,
    ].join("\n"),
  });
  return result.ok;
}

export async function sendDailySummary(
  trades: number,
  netPnl: number,
  capital: number,
): Promise<boolean> {
  const result = await sendTelegram({
    text: [
      `\u{1F4CA} <b>Resumen diario</b>`,
      `Trades: ${trades} | Resultado neto: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`,
      `Capital actual: $${capital.toFixed(2)}`,
    ].join("\n"),
  });
  return result.ok;
}

export async function sendTestMessage(): Promise<boolean> {
  const result = await sendTelegram({
    text: "\u{1F916} <b>Test de conexion</b>\nTelegram conectado correctamente a mi-tradingview.",
  });
  return result.ok;
}
