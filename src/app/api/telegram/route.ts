import { NextResponse } from "next/server";

function getBotToken() { return process.env.TELEGRAM_BOT_TOKEN ?? ""; }
function getChatId() { return process.env.TELEGRAM_CHAT_ID ?? ""; }

export async function POST(request: Request) {
  const botToken = getBotToken();
  const chatId = getChatId();

  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: "Telegram not configured" }, { status: 500 });
  }

  const body = (await request.json()) as {
    text: string;
    reply_markup?: unknown;
  };

  if (!body.text) {
    return NextResponse.json({ ok: false, error: "Missing text" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: body.text,
    parse_mode: "HTML",
  };
  if (body.reply_markup) {
    payload.reply_markup = body.reply_markup;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.ok) {
    return NextResponse.json({ ok: false, error: data.description ?? "Unknown error" });
  }
  return NextResponse.json({ ok: true, message_id: data.result?.message_id });
}
