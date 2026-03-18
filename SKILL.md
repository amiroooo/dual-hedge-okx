# Skill: Dual-Hedged Futures Grid (OpenClaw 2026)

## Overview
A delta-neutral volatility capture strategy that deploys two simultaneous Futures Grid Algos (LONG and SHORT) on the same Binance pair. It utilizes a 'Kill Switch' mechanism to ensure atomic closure of positions if market conditions breach the defined safety range.

## Architecture
- **Framework:** OpenClaw (2026)
- **Language:** TypeScript
- **Exchange:** Binance Futures (Testnet Supported)
- **Communication:** 
  - `/market`: WebSocket stream for Mark Price monitoring.
  - `/private`: WebSocket stream for Strategy State/Updates.
  - `REST`: Order execution (Place/Cancel/Close).

## Parameters
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `symbol` | string | Trading pair (e.g., "BTCUSDT") |
| `marginPerBot` | number | USDT margin allocated to EACH side (Long & Short) |
| `leverage` | number | Futures leverage (e.g., 5, 10, 20) |
| `deltaPercent` | number | Range deviation from current price (e.g., 0.05 for 5%) |
| `gridLevels` | number | Number of orders per side (Default: 10) |

## Safety Logic (Atomic Close)
The system maintains a **Kill Switch** state.
1. **Monitor:** Continuously listens to Mark Price via `/market` WS.
2. **Trigger:** 
   - If Mark Price exits the calculated `[LowerBound, UpperBound]`.
   - OR if `/private` WS emits a `STRATEGY_UPDATE` indicating one bot has stopped/failed.
3. **Action:** 
   - Immediately cancels all open orders on both Long and Short grids.
   - Market closes all open positions on both sides.
   - Emits `SKILL_TERMINATED` event.

## Risks
- **Liquidation Risk:** High leverage with grid strategies can lead to liquidation if price trends strongly in one direction before the Kill Switch triggers.
- **Slippage:** Atomic close uses Market Orders; significant slippage may occur during high volatility.
- **Funding Fees:** Holding simultaneous Long/Short positions incurs funding fees on both sides (netting depends on rate).

## Version
1.0.0 (OpenClaw 2026 Compatible)