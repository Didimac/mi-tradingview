import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.BINANCE_API_KEY ?? "";
  const secretKey = process.env.BINANCE_SECRET_KEY ?? "";
  const realMoney = apiKey.length > 0 && secretKey.length > 0;

  return NextResponse.json({ realMoney });
}
