"use client";

import { getBinanceWS } from "@/lib/binance/ws";
import type { OpportunityScore } from "@/lib/scoring/opportunityScorer";
import {
  sendPhase1Alert,
  sendPhase2Alert,
  sendOpportunityExpired,
  sendPriceEscaped,
  sendSignalCancelled,
} from "./telegramNotifier";

// ─── Types ───

interface ActiveOpportunity {
  symbol: string;
  phase: 1 | 2;
  score: OpportunityScore;
  timestamp: number;          // ms when Phase 1 was sent
  phase1MessageId?: number;   // Telegram message ID for Phase 1
  phase2MessageId?: number;   // Telegram message ID for Phase 2
  phase2Timestamp?: number;   // ms when Phase 2 was sent
}

// ─── Constants ───

const OPPORTUNITY_EXPIRY_MS = 2 * 60 * 60 * 1000;   // 2 hours
const PHASE1_COOLDOWN_MS = 2 * 60 * 60 * 1000;       // 2 hours anti-spam
const IDEAL_ZONE_TOLERANCE = 0.001;                    // ±0.1%
const SCORE_CANCEL_THRESHOLD = 60;

// ─── State ───

const activeOpportunities = new Map<string, ActiveOpportunity>();
const lastPhase1Time = new Map<string, number>();      // anti-spam tracker
let wsUnsubscribe: (() => void) | null = null;
let expiryInterval: ReturnType<typeof setInterval> | null = null;
let started = false;

// ─── Callbacks for UI integration ───

type WatcherCallback = (event: string, symbol: string, data?: unknown) => void;
let onEvent: WatcherCallback | null = null;

export function setWatcherCallback(cb: WatcherCallback | null) {
  onEvent = cb;
}

// ─── Core logic ───

function isInIdealZone(price: number, idealPrice: number): boolean {
  return Math.abs(price - idealPrice) / idealPrice <= IDEAL_ZONE_TOLERANCE;
}

function hasPriceEscaped(price: number, opp: ActiveOpportunity): boolean {
  const { score } = opp;
  if (score.direction === "LONG") {
    return price > score.entryZone.latest;
  } else {
    return price < score.entryZone.latest;
  }
}

async function handlePriceTick(symbol: string, price: number) {
  const opp = activeOpportunities.get(symbol);
  if (!opp) return;

  // Only monitor price during Phase 1 (waiting for ideal entry)
  if (opp.phase !== 1) return;

  // Check if price reached ideal zone → trigger Phase 2
  if (isInIdealZone(price, opp.score.entryZone.ideal)) {
    opp.phase = 2;
    opp.phase2Timestamp = Date.now();

    const result = await sendPhase2Alert(opp.score, price);
    opp.phase2MessageId = result.messageId;

    onEvent?.("phase2", symbol, { price });

    // Phase 2 sent — remove from active monitoring after 30 min (button expiry handled by webhook)
    setTimeout(() => {
      if (activeOpportunities.get(symbol)?.phase === 2) {
        activeOpportunities.delete(symbol);
        onEvent?.("phase2_expired", symbol);
      }
    }, 30 * 60 * 1000);

    return;
  }

  // Check if price escaped (moved past entryZone.latest without pullback)
  if (hasPriceEscaped(price, opp)) {
    activeOpportunities.delete(symbol);
    await sendPriceEscaped(symbol);
    onEvent?.("escaped", symbol, { price });
    return;
  }
}

function checkExpiries() {
  const now = Date.now();
  for (const [symbol, opp] of activeOpportunities) {
    if (opp.phase === 1 && now - opp.timestamp > OPPORTUNITY_EXPIRY_MS) {
      activeOpportunities.delete(symbol);
      sendOpportunityExpired(symbol);
      onEvent?.("expired", symbol);
    }
  }
}

// ─── Public API ───

/**
 * Register a new opportunity (score >= 70).
 * Sends Phase 1 alert and starts watching price via WebSocket.
 */
export async function registerOpportunity(score: OpportunityScore): Promise<boolean> {
  const { symbol } = score;

  // Anti-spam: max 1 Phase 1 per pair every 2 hours
  const lastTime = lastPhase1Time.get(symbol) ?? 0;
  if (Date.now() - lastTime < PHASE1_COOLDOWN_MS) {
    return false;
  }

  // Already watching this symbol
  if (activeOpportunities.has(symbol)) {
    return false;
  }

  // Send Phase 1 alert
  const result = await sendPhase1Alert(score);
  if (!result.ok) return false;

  const opp: ActiveOpportunity = {
    symbol,
    phase: 1,
    score,
    timestamp: Date.now(),
    phase1MessageId: result.messageId,
  };

  activeOpportunities.set(symbol, opp);
  lastPhase1Time.set(symbol, Date.now());
  onEvent?.("phase1", symbol, { score: score.score });

  // Ensure WebSocket subscription covers this symbol
  ensureWsSubscription();

  return true;
}

/**
 * Update score for an active opportunity.
 * If score drops below 60, cancel the opportunity.
 */
export async function updateScore(symbol: string, newScore: number) {
  const opp = activeOpportunities.get(symbol);
  if (!opp || opp.phase !== 1) return;

  if (newScore < SCORE_CANCEL_THRESHOLD) {
    activeOpportunities.delete(symbol);
    await sendSignalCancelled(symbol, newScore);
    onEvent?.("cancelled", symbol, { newScore });
  }
}

/**
 * Check if a symbol has an active opportunity (for UI display).
 */
export function getActiveOpportunity(symbol: string): ActiveOpportunity | undefined {
  return activeOpportunities.get(symbol);
}

/**
 * Get all active opportunities.
 */
export function getAllActiveOpportunities(): ActiveOpportunity[] {
  return Array.from(activeOpportunities.values());
}

/**
 * Check if Phase 1 alert can be sent for a symbol (anti-spam check).
 */
export function canSendPhase1(symbol: string): boolean {
  const lastTime = lastPhase1Time.get(symbol) ?? 0;
  return Date.now() - lastTime >= PHASE1_COOLDOWN_MS && !activeOpportunities.has(symbol);
}

// ─── WebSocket management ───

function ensureWsSubscription() {
  // Get all symbols being watched
  const watchedSymbols = Array.from(activeOpportunities.keys());
  if (watchedSymbols.length === 0) {
    // No opportunities — unsubscribe
    wsUnsubscribe?.();
    wsUnsubscribe = null;
    return;
  }

  // Re-subscribe with current symbol list
  wsUnsubscribe?.();
  const ws = getBinanceWS();
  wsUnsubscribe = ws.subscribeMiniTickers(watchedSymbols, (tick) => {
    handlePriceTick(tick.symbol, tick.close);
  });
}

// ─── Lifecycle ───

export function startOpportunityWatcher() {
  if (started) return;
  started = true;

  // Check expiries every 30 seconds
  expiryInterval = setInterval(checkExpiries, 30_000);
}

export function stopOpportunityWatcher() {
  started = false;
  wsUnsubscribe?.();
  wsUnsubscribe = null;
  if (expiryInterval) {
    clearInterval(expiryInterval);
    expiryInterval = null;
  }
  activeOpportunities.clear();
}
