import PDFDocument from "pdfkit";
import fs from "fs";

const doc = new PDFDocument({ size: "A4", margin: 50 });
const out = fs.createWriteStream("Crypto_Pulse_Report.pdf");
doc.pipe(out);

// ── Colors ──
const BG       = "#1a1a2e";
const BG_CARD  = "#232340";
const TEXT     = "#e0e0e8";
const MUTED    = "#9090a8";
const ACCENT   = "#4f8cff";
const GREEN    = "#3ecf8e";
const RED      = "#ef5350";
const HEADER   = "#ffffff";
const DIVIDER  = "#3a3a5c";

const W = 595.28; // A4 width
const H = 841.89;
const M = 50;
const CW = W - M * 2; // content width

// ── Helpers ──

function bgFill() {
  doc.save().rect(0, 0, W, H).fill(BG).restore();
}

function drawDivider(y) {
  doc.save().moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor(DIVIDER).stroke().restore();
  return y + 8;
}

function sectionTitle(text, y) {
  doc.save();
  doc.roundedRect(M, y, CW, 28, 4).fill(BG_CARD);
  doc.fontSize(12).font("Helvetica-Bold").fillColor(ACCENT).text(text, M + 10, y + 7, { width: CW - 20 });
  doc.restore();
  return y + 38;
}

function bodyText(text, y, opts = {}) {
  doc.fontSize(opts.size || 9.5).font(opts.font || "Helvetica").fillColor(opts.color || TEXT);
  doc.text(text, M, y, { width: CW, lineGap: 3, ...opts });
  return doc.y + 4;
}

function bulletList(items, y) {
  for (const item of items) {
    doc.fontSize(9).font("Helvetica").fillColor(TEXT);
    doc.text(`  •  ${item}`, M + 8, y, { width: CW - 16, lineGap: 2 });
    y = doc.y + 2;
  }
  return y + 4;
}

// ══════════════════════════════════════════════════════════════
// PAGE 1 — TITLE + OVERVIEW
// ══════════════════════════════════════════════════════════════
bgFill();

// Title block
let y = 120;
doc.fontSize(28).font("Helvetica-Bold").fillColor(HEADER)
  .text("Crypto Pulse", M, y, { width: CW, align: "center" });
y = doc.y + 2;
doc.fontSize(14).font("Helvetica").fillColor(ACCENT)
  .text("Strategy & Backtest Report", M, y, { width: CW, align: "center" });
y = doc.y + 20;
drawDivider(y);
y += 12;

doc.fontSize(10).font("Helvetica").fillColor(MUTED)
  .text("Date: May 23, 2026   |   Timeframe: 4H   |   Capital: $10,000 USDT   |   Period: 1 year", M, y, { width: CW, align: "center" });
y = doc.y + 30;

// Section 1
y = sectionTitle("1. Strategy Overview", y);
y = bodyText("Crypto Pulse is a hybrid trend + bounce strategy designed for cryptocurrency USDT pairs with daily volume above 50M. It adapts its behavior based on whether the market is trending or ranging.", y);
y += 4;

y = bodyText("Key Features:", y, { font: "Helvetica-Bold", color: ACCENT, size: 10 });
y = bulletList([
  "Dual regime detection: TREND mode (EMA separation > 0.3%) vs RANGE mode",
  "ATR-based Stop Loss (1.5x ATR) and Take Profit (3.0x ATR) — adapts to each pair",
  "Trailing stop to breakeven when price moves 1x ATR in favor",
  "Volume confirmation filter (1.5x avg in trend, 1.2x in range)",
  "RSI cross + engulfing pattern detection for entries",
], y);

y = bodyText("Default Parameters:", y, { font: "Helvetica-Bold", color: ACCENT, size: 10 });
y += 2;

// Params table
const params = [
  ["EMA Fast / Slow", "21 / 55", "RSI Period", "14"],
  ["ATR Period", "14", "ATR SL Mult", "1.5x"],
  ["ATR TP Mult", "3.0x", "RSI OB / OS", "78 / 22"],
  ["Risk per Trade", "1.5%", "Trend Sep %", "0.3%"],
];

const colW = CW / 4;
for (const row of params) {
  for (let c = 0; c < 4; c++) {
    const isLabel = c % 2 === 0;
    doc.fontSize(8.5).font(isLabel ? "Helvetica-Bold" : "Helvetica")
      .fillColor(isLabel ? MUTED : TEXT)
      .text(row[c], M + c * colW, y, { width: colW, align: "left" });
  }
  y = doc.y + 3;
}
y += 8;

// Entry rules
y = bodyText("Entry Rules — TREND mode:", y, { font: "Helvetica-Bold", color: GREEN, size: 9.5 });
y = bulletList([
  "LONG: EMA21 > EMA55 + RSI crosses above 50 + price closes above EMA21 + volume confirmed",
  "SHORT: EMA21 < EMA55 + RSI crosses below 50 + price closes below EMA21 + volume confirmed",
], y);

y = bodyText("Entry Rules — RANGE mode:", y, { font: "Helvetica-Bold", color: GREEN, size: 9.5 });
y = bulletList([
  "LONG: RSI bounces from <=35 + price touches/above EMA55 + bullish engulfing or volume",
  "SHORT: RSI drops from >=65 + price touches/below EMA55 + bearish engulfing or volume",
], y);

y = bodyText("Exit Rules:", y, { font: "Helvetica-Bold", color: RED, size: 9.5 });
y = bulletList([
  "Stop Loss hit (ATR-based)",
  "Take Profit hit (ATR-based)",
  "RSI extreme (>78 long, <22 short)",
  "EMA cross against position direction",
  "Trailing: SL moves to breakeven after 1x ATR move in favor",
], y);

// ══════════════════════════════════════════════════════════════
// PAGE 2 — RESULTS TABLE + ANALYSIS
// ══════════════════════════════════════════════════════════════
doc.addPage({ size: "A4", margin: M });
bgFill();

y = 50;
y = sectionTitle("2. Backtest Results", y);
y += 4;

// Results table
const headers = ["Par", "Trades", "Win Rate", "Profit Factor", "Retorno", "Max DD", "Equity Final"];
const data = [
  ["BTCUSDT", "6", "33.3%", "0.82", "-1.38%", "7.65%", "$9,861"],
  ["ETHUSDT", "9", "22.2%", "1.01", "+0.15%", "6.25%", "$10,015"],
  ["SOLUSDT", "5", "60.0%", "5.18", "+16.63%", "3.70%", "$11,663"],
  ["BNBUSDT", "3", "33.3%", "0.56", "-2.13%", "4.68%", "$9,787"],
];

const cols = [70, 55, 65, 80, 70, 60, 80];
const tableX = M + 5;
const rowH = 22;

// Header row
doc.save().roundedRect(tableX - 4, y, CW, rowH, 3).fill(ACCENT).restore();
let cx = tableX;
for (let c = 0; c < headers.length; c++) {
  doc.fontSize(9).font("Helvetica-Bold").fillColor("#ffffff")
    .text(headers[c], cx, y + 6, { width: cols[c], align: c === 0 ? "left" : "center" });
  cx += cols[c];
}
y += rowH + 2;

// Data rows
for (let r = 0; r < data.length; r++) {
  const rowBg = r % 2 === 0 ? BG_CARD : BG;
  doc.save().rect(tableX - 4, y, CW, rowH).fill(rowBg).restore();
  cx = tableX;
  for (let c = 0; c < data[r].length; c++) {
    let color = TEXT;
    if (c === 4) color = data[r][c].startsWith("+") ? GREEN : RED; // return
    if (c === 5) color = RED; // drawdown
    if (c === 3) { // profit factor
      const pf = parseFloat(data[r][c]);
      color = pf >= 1 ? GREEN : RED;
    }
    doc.fontSize(9).font(c === 0 ? "Helvetica-Bold" : "Helvetica").fillColor(color)
      .text(data[r][c], cx, y + 6, { width: cols[c], align: c === 0 ? "left" : "center" });
    cx += cols[c];
  }
  y += rowH;
}

y += 20;

// Section 3 — Analysis
y = sectionTitle("3. Analysis by Pair", y);
y += 2;

const analyses = [
  {
    pair: "BTCUSDT",
    color: "#f7931a",
    lines: [
      "6 trades in 1 year, only 2 winners",
      "Highest drawdown at 7.65%",
      "BTC's lower volatility relative to price means fewer signals pass volume filter",
      "Slight loss of -1.38%",
    ]
  },
  {
    pair: "ETHUSDT",
    color: "#627eea",
    lines: [
      "Most active pair with 9 trades",
      "Very low win rate (22.2%) but profit factor near 1.0",
      "2 winning trades almost exactly offset 7 losing trades",
      "Practically breakeven at +0.15%",
    ]
  },
  {
    pair: "SOLUSDT",
    color: GREEN,
    lines: [
      "Best performer: +16.63% return with only 3.70% max drawdown",
      "60% win rate with outstanding profit factor of 5.18",
      "SOL's higher volatility creates better ATR-based risk/reward setups",
      "3 wins out of 5 trades — winners significantly larger than losers",
    ]
  },
  {
    pair: "BNBUSDT",
    color: "#f3ba2f",
    lines: [
      "Least active with only 3 trades in the period",
      "1 winner vs 2 losers",
      "Worst return at -2.13%",
      "BNB's lower volatility generates few qualifying signals",
    ]
  },
];

for (const a of analyses) {
  // Pair badge
  doc.save().roundedRect(M, y, 75, 16, 3).fill(a.color).restore();
  doc.fontSize(9).font("Helvetica-Bold").fillColor("#ffffff").text(a.pair, M + 6, y + 3);
  y += 20;
  y = bulletList(a.lines, y);
  y += 4;
}

// ══════════════════════════════════════════════════════════════
// PAGE 3 — CONCLUSIONS
// ══════════════════════════════════════════════════════════════
doc.addPage({ size: "A4", margin: M });
bgFill();

y = 50;
y = sectionTitle("4. Conclusions & Recommendations", y);
y += 4;

const conclusions = [
  {
    title: "SOL is the clear winner",
    body: "The strategy works best on higher-volatility assets where ATR-based levels create meaningful risk/reward ratios. SOL's price action consistently generates quality setups.",
  },
  {
    title: "Highly conservative approach",
    body: "Only 3 to 9 trades per year due to strict multi-filter entry requirements (EMA alignment + RSI cross + volume confirmation). This is by design — quality over quantity.",
  },
  {
    title: "Drawdowns are well-controlled",
    body: "Maximum drawdown across all pairs was 7.65% (BTC). ATR-based stops adapt to volatility, and the trailing stop to breakeven mechanism protects open profits.",
  },
  {
    title: "Volume filter is crucial",
    body: "Prevents false entries during low-conviction moves. The different multipliers for trend (1.5x) vs range (1.2x) modes add adaptability.",
  },
  {
    title: "Recommended improvements",
    body: "Consider widening RSI thresholds (e.g., 45-55 instead of 48-52) for more trend signals. Testing on 1H timeframe could increase trade frequency while maintaining the same logic. Adding ADX as a trend strength filter could improve TREND mode entries.",
  },
];

for (let i = 0; i < conclusions.length; i++) {
  const c = conclusions[i];
  // Number badge
  doc.save().circle(M + 10, y + 7, 10).fill(ACCENT).restore();
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text(`${i + 1}`, M + 6, y + 2, { width: 10, align: "center" });

  doc.fontSize(10).font("Helvetica-Bold").fillColor(HEADER).text(c.title, M + 28, y + 1, { width: CW - 30 });
  y = doc.y + 3;
  doc.fontSize(9).font("Helvetica").fillColor(MUTED).text(c.body, M + 28, y, { width: CW - 30, lineGap: 2 });
  y = doc.y + 14;
}

y += 10;
drawDivider(y);
y += 12;

// Disclaimer
doc.fontSize(7.5).font("Helvetica-Oblique").fillColor(MUTED)
  .text("DISCLAIMER: This report is for informational and educational purposes only. Past performance does not guarantee future results. Cryptocurrency trading involves substantial risk of loss. This is not financial advice. Always do your own research before trading.", M, y, { width: CW, lineGap: 2 });

y = doc.y + 30;

// Footer
doc.fontSize(8).font("Helvetica").fillColor(DIVIDER)
  .text("Generated by Crypto Pulse Backtester — mi-tradingview", M, y, { width: CW, align: "center" });

// ── Finalize ──
doc.end();

out.on("finish", () => {
  console.log("PDF created: Crypto_Pulse_Report.pdf");
});
