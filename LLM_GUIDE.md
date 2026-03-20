# 🤖 AI Development & Maintenance Guide

This document is designed for LLMs and AI coding assistants (like Gemini, Cursor, or Claude) to understand the architecture and nuances of the **OKX Dual-Hedged Futures Grid** project.

## 📁 Project Structure
1.  **`dual-grid.ts`**: The core deployment engine. Used to create a pair of Long/Short geometric grid bots with advanced safety checks.
2.  **`find-optimal-pairs.ts`**: Market analysis scanner. Suggests pairs with high "Chop Scores" (intra-range oscillation) and low directional drift.
3.  **`manage-bots.ts`**: Portfolio management. Groups active bots by pair, calculates aggregate PnL, and provides a global "Kill Switch."

---

## 🛠️ Key Technical Patterns (For Future AI)

### 1. Geometric Grid Calculation
OKX native geometric grids are created using `runType: '2'`.
- The script calculates the **Max Grid Number** (between 150 downwards to 2) that satisfies:
  - **Fee Profitability**: Step profit > 0.12% (round-trip).
  - **Absolute Profit**: Net USDT profit > `MIN_ABSOLUTE_PROFIT_USDT` (Default: $0.10).

### 2. Liquidation Safety & "Effective Leverage"
- **The Problem**: OKX Grid bots don't have a native "investment padding" field like Binance.
- **The Solution**: 
  - The script accepts a 4th CLI argument `EXTRA_MARGIN_USDT`.
  - It calculates **Effective Leverage** as: `Notional / (Base Margin + Extra Margin)`.
  - It enforces a **20% safety buffer**: The estimated liquidation price must be at least 20% further away than the manual Stop Loss.
  - **Post-Creation Injection**: After `order-algo` (bot creation), the script waits 2 seconds and calls `POST /api/v5/tradingBot/grid/margin-balance` with `type: 'add'` to inject the padding.

### 4. Margin Partitioning (Actual vs. Reserved)
When an LLM works on the margin logic, it must understand OKX's internal split:
- **Actual Margin**: The portion of `sz` used for placing grid orders.
- **Reserved Margin**: The portion of `sz` held by OKX as a safety buffer within the bot.
- **Manual Padding**: The `EXTRA_MARGIN_USDT` added via `margin-balance/add`. This is 100% "Reserved" (safety only).
**Constraint**: Users cannot manually define the internal split of `sz`. They can only control the total `sz` and the additional `Manual Padding`.

---

## 🚀 How to Expand the Project
When asking an LLM to improve this project, suggest these specific areas:

### Improve the "Chop Score"
- **Current**: `Sum of 1H absolute moves / Total Range`.
- **Ideal**: Integrate ATR (Average True Range) vs. Trend Strength (ADX) to find even tighter "crab" markets.

### Enhance the Manager
- Add an "Auto-Rebalance" feature that stops and restarts bots if the price drifts outside the ±10% range.
- Implement Telegram notifications for bot creation/termination using `trailingBot` info.

### Strategy Variations
- Implement "Arithmetic" grids as a fallback if the range is extremely tight.
- Add "Trailing Up/Down" logic once OKX V5 fully stabilizes those parameters via API.

---

## ⚠️ Safety Reminders
- Always perform a **Pre-flight Balance Check** before allowing individual bot deployments.
- Always fetch **Instrument Details** (`ctVal`, `tickSz`) before calculating trade sizes to avoid rounding errors.
- Always use **Isolated Margin** for Grid Bots to prevent cross-account liquidation.
