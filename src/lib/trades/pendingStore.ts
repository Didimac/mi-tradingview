export interface PendingTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  sl: number;
  tp1: number;
  tp2: number;
  qty: number;
  reason: string;
  timestamp: number;
}

const pending: PendingTrade[] = [];

export function addPendingTrade(trade: PendingTrade) {
  pending.push(trade);
}

export function getPendingTrades(): PendingTrade[] {
  return [...pending];
}

export function clearPendingTrades(): PendingTrade[] {
  return pending.splice(0);
}
