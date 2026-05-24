import { NextResponse } from "next/server";
import { isBinanceConfigured, placeMarketOrder, placeOCO } from "@/lib/binance/trading";
import { addPendingTrade } from "@/lib/trades/pendingStore";

function getBotToken() { return process.env.TELEGRAM_BOT_TOKEN ?? ""; }

const EPOCH = new Date("2025-01-01").getTime();
const EXPIRY_MINUTES = 30;

async function tgApi(method: string, body: Record<string, unknown>) {
  const token = getBotToken();
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function POST(request: Request) {
  const update = await request.json();
  const callback = update.callback_query;
  if (!callback) {
    return NextResponse.json({ ok: true });
  }

  const data: string = callback.data ?? "";
  const callbackId: string = callback.id;
  const chatId: number = callback.message?.chat?.id;
  const messageId: number = callback.message?.message_id;
  const originalText: string = callback.message?.text ?? "";

  // ─── IGNORE (format: i:SYM:TMIN) ───
  if (data.startsWith("i:")) {
    await tgApi("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Senal ignorada",
    });
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: originalText + "\n\n\u{274C} <b>Senal ignorada</b>",
      parse_mode: "HTML",
    });
    return NextResponse.json({ ok: true });
  }

  // ─── EXECUTE (format: x:SYM:D:ENTRY:SL:TP1:TP2:QTY100:TMIN) ───
  if (data.startsWith("x:")) {
    const parts = data.split(":");
    if (parts.length < 9) {
      await tgApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Datos invalidos",
        show_alert: true,
      });
      return NextResponse.json({ ok: true });
    }

    const sym = parts[1] + "USDT";
    const dirChar = parts[2];
    const direction = dirChar === "L" ? "LONG" : "SHORT";
    const price = parseInt(parts[3]) / 100;
    const sl = parseInt(parts[4]) / 100;
    const tp1 = parseInt(parts[5]) / 100;
    const tp2 = parseInt(parts[6]) / 100;
    const qty = parseInt(parts[7]) / 10000;
    const tMin = parseInt(parts[8]);

    // Check expiry
    const signalTime = EPOCH + tMin * 60000;
    const elapsed = (Date.now() - signalTime) / 60000;
    if (elapsed > EXPIRY_MINUTES) {
      await tgApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "Senal expirada (mas de 30 min)",
        show_alert: true,
      });
      await tgApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: originalText + "\n\n\u{23F0} <b>Senal expirada</b>",
        parse_mode: "HTML",
      });
      return NextResponse.json({ ok: true });
    }

    let mode = "PAPER";
    let orderError = "";

    if (isBinanceConfigured()) {
      mode = "REAL";
      const side = direction === "LONG" ? "BUY" as const : "SELL" as const;
      const marketResult = await placeMarketOrder(sym, side, qty);
      if (!marketResult.ok) {
        orderError = marketResult.error ?? "Error desconocido";
      } else {
        const exitSide = direction === "LONG" ? "SELL" as const : "BUY" as const;
        const ocoResult = await placeOCO(sym, exitSide, qty, tp1, sl, sl);
        if (!ocoResult.ok) {
          orderError = `Market OK, OCO fallo: ${ocoResult.error}`;
        }
      }
    } else {
      addPendingTrade({
        id: `${sym}-${tMin}`,
        symbol: sym,
        side: direction === "LONG" ? "long" : "short",
        price,
        sl,
        tp1,
        tp2,
        qty,
        reason: `Telegram Modo B | ${direction}`,
        timestamp: Math.floor(signalTime / 1000),
      });
    }

    if (orderError) {
      await tgApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: `Error: ${orderError}`,
        show_alert: true,
      });
      await tgApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: originalText + `\n\n\u{26A0}\u{FE0F} <b>Error en orden</b>\n${orderError}`,
        parse_mode: "HTML",
      });
    } else {
      await tgApi("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: `Orden ${mode} ejecutada`,
      });
      await tgApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: originalText +
          `\n\n\u{2705} <b>Orden ${mode} ejecutada</b>` +
          `\n${direction} ${sym} | Qty: ${qty.toFixed(4)} | SL: ${sl.toFixed(2)} | TP: ${tp1.toFixed(2)}`,
        parse_mode: "HTML",
      });
    }

    return NextResponse.json({ ok: true });
  }

  await tgApi("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "Accion desconocida",
  });

  return NextResponse.json({ ok: true });
}
