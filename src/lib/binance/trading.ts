import { createHmac } from "crypto";

const BASE = "https://api.binance.com";

function getKeys() {
  return {
    apiKey: process.env.BINANCE_API_KEY ?? "",
    secretKey: process.env.BINANCE_SECRET_KEY ?? "",
  };
}

export function isBinanceConfigured(): boolean {
  const { apiKey, secretKey } = getKeys();
  return apiKey.length > 0 && secretKey.length > 0;
}

function sign(queryString: string): string {
  const { secretKey } = getKeys();
  return createHmac("sha256", secretKey).update(queryString).digest("hex");
}

async function signedRequest(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const { apiKey } = getKeys();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  qs.set("timestamp", String(Date.now()));
  qs.set("recvWindow", "5000");

  const queryString = qs.toString();
  const signature = sign(queryString);

  const url = `${BASE}${endpoint}?${queryString}&signature=${signature}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });

  const data = await res.json();
  if (!res.ok) {
    return { ok: false, error: data.msg ?? `HTTP ${res.status}` };
  }
  return { ok: true, data };
}

export async function placeMarketOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
) {
  return signedRequest("/api/v3/order", {
    symbol: symbol.toUpperCase(),
    side,
    type: "MARKET",
    quantity: quantity.toFixed(8),
  });
}

export async function placeLimitOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  price: number,
) {
  return signedRequest("/api/v3/order", {
    symbol: symbol.toUpperCase(),
    side,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: quantity.toFixed(8),
    price: price.toFixed(8),
  });
}

export async function placeOCO(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  takeProfitPrice: number,
  stopPrice: number,
  stopLimitPrice: number,
) {
  return signedRequest("/api/v3/orderList/oco", {
    symbol: symbol.toUpperCase(),
    side,
    quantity: quantity.toFixed(8),
    aboveType: "LIMIT_MAKER",
    abovePrice: takeProfitPrice.toFixed(8),
    belowType: "STOP_LOSS_LIMIT",
    belowPrice: stopPrice.toFixed(8),
    belowStopPrice: stopPrice.toFixed(8),
    belowTimeInForce: "GTC",
  });
}
