---
description: Deploys a Dual-Hedged Futures Grid bot pair on OKX with safety padding and geometric spacing.
---

1. Ensure you have the following parameters ready:
   - `PAIR` (e.g. BTC-USDT-SWAP)
   - `LEVERAGE` (e.g. 10)
   - `MARGIN_PER_BOT` (e.g. 100)
   - `EXTRA_PADDING` (Optional, e.g. 50)

2. Run the deployment script:
// turbo
3. `npx ts-node dual-grid.ts <PAIR> <LEVERAGE> <MARGIN_PER_BOT> [EXTRA_PADDING]`

4. Review the Deployment Summary (Funding, Liquidation Safely, Grid Number) and confirm with 'y'.
5. You must never confirm deployment without user approval first.