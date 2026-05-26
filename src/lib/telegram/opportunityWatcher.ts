"use client";

/**
 * OpportunityWatcher v2 — Auto Paper Trading
 *
 * When SmartScorer detects score >= 75:
 *   1. Auto-opens paper trade (no manual buttons)
 *   2. Sends Telegram Phase 1: "Señal detectada — entrando automáticamente"
 *   3. Sends Telegram Phase 2: "Entrada ejecutada en $price"
 *   4. On close (SL/TP1/TP2): sends Telegram result
 *
 * Buttons (Ejecutar/Ignorar) only appear when BINANCE_API_KEY is configured
 * (real money mode, handled by sendPhase2Alert with buttons).
 *
 * Max 1 position open at a time.
 */

import type { OpportunityScore } from "@/lib/scoring/opportunityScorer";
import {
  autoOpenTrade,
  hasOpenPosition,
  isAutoModeActive,
  onTradeEvent,
  startPriceMonitor,
  usePaperTrading,
} from "@/lib/papertrading/paperTradingEngine";
import {
  sendAutoSignalDetected,
  sendAutoEntryExecuted,
  sendAutoTradeClose,
  sendAutoPartialClose,
  sendPhase1Alert,
} from "./telegramNotifier";

// ─── Constants ───

const PHASE1_COOLDOWN_MS = 2 * 60 * 60 * 1000;   // 2h anti-spam per pair
const SCORE_CANCEL_THRESHOLD = 40;

// ─── State ───

const lastSignalTime = new Map<string, number>();
let started = false;

// Track which symbols have active auto-trades (for UI display)
const activeAutoTrades = new Map<string, { score: OpportunityScore; timestamp: number }>();

// ─── Callbacks for UI integration ───

type WatcherCallback = (event: string, symbol: string, data?: unknown) => void;
let onEvent: WatcherCallback | null = null;

export function setWatcherCallback(cb: WatcherCallback | null) {
  onEvent = cb;
}

// ─── Fetch trading mode from server ───

async function fetchTradingMode() {
  try {
    const res = await fetch("/api/config/trading-mode");
    const data = await res.json();
    usePaperTrading.getState().setTradingMode(data.realMoney ? "real" : "paper");
    console.log(`[AutoPaper] Server mode: ${data.realMoney ? "REAL" : "PAPER"}`);
  } catch {
    // default stays "paper"
  }
}

// ─── Manual mode: send Telegram with buttons, wait for user ───

async function manualSignal(score: OpportunityScore): Promise<boolean> {
  const lastTime = lastSignalTime.get(score.symbol) ?? 0;
  if (Date.now() - lastTime < PHASE1_COOLDOWN_MS) return false;

  // Send Phase 1 (informational)
  const result = await sendPhase1Alert(score);
  if (!result.ok) return false;

  lastSignalTime.set(score.symbol, Date.now());
  activeAutoTrades.set(score.symbol, { score, timestamp: Date.now() });
  onEvent?.("manual_signal", score.symbol, { score: score.score });

  console.log(`[Manual] Signal sent to Telegram: ${score.symbol} ${score.direction} score=${score.score}`);
  return true;
}

// ─── Core: Auto-enter paper trade ───

async function autoEnterTrade(score: OpportunityScore): Promise<boolean> {
  // Max 1 position
  if (hasOpenPosition()) {
    console.log(`[AutoPaper] Skipping ${score.symbol} — position already open`);
    return false;
  }

  // Anti-spam: max 1 signal per pair every 2h
  const lastTime = lastSignalTime.get(score.symbol) ?? 0;
  if (Date.now() - lastTime < PHASE1_COOLDOWN_MS) {
    console.log(`[AutoPaper] Skipping ${score.symbol} — cooldown active`);
    return false;
  }

  const price = score.entry;
  const side = score.direction === "LONG" ? "long" : "short";

  // Phase 1: Send "signal detected, entering automatically"
  console.log(`[AutoPaper] 📊 Signal detected: ${score.symbol} ${score.direction} score=${score.score}`);
  sendAutoSignalDetected(score);

  // Open paper trade
  const opened = autoOpenTrade({
    symbol: score.symbol,
    side: side as "long" | "short",
    price,
    sl: score.stopLoss,
    tp: score.takeProfit1,
    tp2: score.takeProfit2,
    reason: `SmartScorer v2 | Score ${score.score} | ${score.reason}`,
  });

  if (!opened) {
    console.log(`[AutoPaper] Failed to open trade for ${score.symbol}`);
    return false;
  }

  // Phase 2: Send "entry executed at $price"
  sendAutoEntryExecuted(score, price);

  // Track state
  lastSignalTime.set(score.symbol, Date.now());
  activeAutoTrades.set(score.symbol, { score, timestamp: Date.now() });
  onEvent?.("auto_entry", score.symbol, { score: score.score, price });

  console.log(`[AutoPaper] ✅ Auto-entered ${side.toUpperCase()} ${score.symbol} @ ${price}`);
  return true;
}

// ─── Trade event handler (for Telegram close notifications) ───

function setupTradeEventHandler() {
  onTradeEvent((event, data) => {
    if (event === "close") {
      const { symbol, exitPrice, pnlPct, capital, exitReason } = data;
      console.log(`[AutoPaper] Trade closed: ${symbol} ${exitReason} pnl=${pnlPct?.toFixed(2)}%`);
      sendAutoTradeClose(symbol, exitReason ?? "Unknown", pnlPct ?? 0, capital ?? 0);
      activeAutoTrades.delete(symbol);
      onEvent?.("auto_close", symbol, { exitReason, pnlPct, capital });
    } else if (event === "partial_close") {
      const { symbol, pnlPct, capital } = data;
      console.log(`[AutoPaper] TP1 partial close: ${symbol} +${pnlPct?.toFixed(2)}%`);
      sendAutoPartialClose(symbol, pnlPct ?? 0, capital ?? 0);
      onEvent?.("auto_partial", symbol, { pnlPct, capital });
    }
  });
}

// ─── Public API ───

/**
 * Called from OpportunityBoard when score >= 75 and eligible.
 *
 * Routing logic:
 *   - Real money mode (BINANCE_API_KEY set) → ALWAYS manual with buttons (never auto)
 *   - Paper + autoMode ON  → auto-execute immediately
 *   - Paper + autoMode OFF → send Telegram alert with buttons, wait for confirmation
 */
export async function registerOpportunity(score: OpportunityScore): Promise<boolean> {
  if (isAutoModeActive()) {
    return autoEnterTrade(score);
  }

  // Manual mode (or real money mode) → send alert, wait for user
  return manualSignal(score);
}

/**
 * Update score for a symbol. If score dropped below threshold, log it.
 * Note: position close is handled by SL/TP via WebSocket, not by score drop.
 */
export async function updateScore(symbol: string, newScore: number) {
  if (newScore < SCORE_CANCEL_THRESHOLD) {
    console.log(`[AutoPaper] Score dropped for ${symbol}: ${newScore} (below ${SCORE_CANCEL_THRESHOLD})`);
    // Don't close the trade — SL/TP handles exit. Just notify.
    onEvent?.("score_drop", symbol, { newScore });
  }
}

/**
 * Check if Phase 1 alert can be sent for a symbol (anti-spam + no open position).
 */
export function canSendPhase1(symbol: string): boolean {
  if (hasOpenPosition()) return false;
  const lastTime = lastSignalTime.get(symbol) ?? 0;
  return Date.now() - lastTime >= PHASE1_COOLDOWN_MS;
}

/**
 * Get active auto-trade for a symbol (for UI Eye icon).
 */
export function getActiveOpportunity(symbol: string) {
  return activeAutoTrades.get(symbol);
}

/**
 * Get all active auto-trades.
 */
export function getAllActiveOpportunities() {
  return Array.from(activeAutoTrades.values());
}

// ─── Lifecycle ───

export function startOpportunityWatcher() {
  if (started) return;
  started = true;

  // Start WebSocket price monitor for SL/TP checking
  startPriceMonitor();

  // Setup trade event handler for Telegram notifications
  setupTradeEventHandler();

  // Fetch trading mode from server (real vs paper)
  fetchTradingMode();

  const { autoMode } = usePaperTrading.getState();
  console.log(`[AutoPaper] Watcher started | autoMode=${autoMode ? "ON" : "OFF"}`);
}

export function stopOpportunityWatcher() {
  started = false;
  activeAutoTrades.clear();
  onTradeEvent(null);
}
