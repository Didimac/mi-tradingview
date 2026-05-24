import type { Trade, EquityPoint, BacktestResult } from "./backtest-engine";

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;            // 0-100
  profitFactor: number;       // gross profit / gross loss
  totalReturn: number;        // percentage
  totalPnl: number;           // absolute USDT
  avgWin: number;             // avg winning trade %
  avgLoss: number;            // avg losing trade %
  maxDrawdown: number;        // max drawdown %
  maxDrawdownDuration: number; // bars
  avgTradeDuration: number;   // bars
  sharpeRatio: number;        // annualized (approx)
  expectancy: number;         // avg expected return per trade (USDT)
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  longTrades: number;
  shortTrades: number;
  longWinRate: number;
  shortWinRate: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

export function calculateMetrics(result: BacktestResult): BacktestMetrics {
  const { trades, equity, startEquity, finalEquity } = result;

  if (trades.length === 0) {
    return emptyMetrics();
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const longTrades = trades.filter((t) => t.side === "long");
  const shortTrades = trades.filter((t) => t.side === "short");
  const longWins = longTrades.filter((t) => t.pnl > 0);
  const shortWins = shortTrades.filter((t) => t.pnl > 0);

  // Max drawdown
  let maxDD = 0;
  for (const ep of equity) {
    if (ep.drawdown > maxDD) maxDD = ep.drawdown;
  }

  // Max drawdown duration (in bars between equity points)
  let maxDDDuration = 0;
  let currentDDStart = -1;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i].drawdown > 0) {
      if (currentDDStart === -1) currentDDStart = i;
    } else {
      if (currentDDStart !== -1) {
        maxDDDuration = Math.max(maxDDDuration, i - currentDDStart);
        currentDDStart = -1;
      }
    }
  }
  if (currentDDStart !== -1) {
    maxDDDuration = Math.max(maxDDDuration, equity.length - currentDDStart);
  }

  // Consecutive wins/losses
  let maxConsWins = 0;
  let maxConsLosses = 0;
  let consWins = 0;
  let consLosses = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      consWins++;
      consLosses = 0;
      maxConsWins = Math.max(maxConsWins, consWins);
    } else {
      consLosses++;
      consWins = 0;
      maxConsLosses = Math.max(maxConsLosses, consLosses);
    }
  }

  // Sharpe ratio (simplified: use trade returns as daily-ish returns)
  const returns = trades.map((t) => t.pnlPct);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Best and worst trade
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: (wins.length / trades.length) * 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    totalReturn: ((finalEquity - startEquity) / startEquity) * 100,
    totalPnl: finalEquity - startEquity,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
    maxDrawdown: maxDD,
    maxDrawdownDuration: maxDDDuration,
    avgTradeDuration:
      trades.reduce((s, t) => s + t.bars, 0) / trades.length,
    sharpeRatio: sharpe,
    expectancy: (finalEquity - startEquity) / trades.length,
    bestTrade: sorted[0] ?? null,
    worstTrade: sorted[sorted.length - 1] ?? null,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longWinRate:
      longTrades.length > 0
        ? (longWins.length / longTrades.length) * 100
        : 0,
    shortWinRate:
      shortTrades.length > 0
        ? (shortWins.length / shortTrades.length) * 100
        : 0,
    consecutiveWins: maxConsWins,
    consecutiveLosses: maxConsLosses,
  };
}

function emptyMetrics(): BacktestMetrics {
  return {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    profitFactor: 0,
    totalReturn: 0,
    totalPnl: 0,
    avgWin: 0,
    avgLoss: 0,
    maxDrawdown: 0,
    maxDrawdownDuration: 0,
    avgTradeDuration: 0,
    sharpeRatio: 0,
    expectancy: 0,
    bestTrade: null,
    worstTrade: null,
    longTrades: 0,
    shortTrades: 0,
    longWinRate: 0,
    shortWinRate: 0,
    consecutiveWins: 0,
    consecutiveLosses: 0,
  };
}
