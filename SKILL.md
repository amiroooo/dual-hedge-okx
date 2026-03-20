# Skill: OKX Dual-Hedged Futures Grid (Geometric)

## Overview
A volatility-capture toolkit that deploys dual-hedged geometric grid bots on OKX perpetual swaps. Focuses on high-chop, low-drift pairs to ensure range preservation and consistent profit compounding.

## Components
1. **Find Optimal Pairs**: Analysis script to identify high-volatility pairs that fit a ±10% range.
   - Run: `/scan-pairs`
2. **Deploy Dual Grids**: Automated geometric bot deployment with Liquidation-vs-SL safety checks.
   - Run: `/deploy-dual-grid <PAIR> <LEVERAGE> <MARGIN> [PADDING]`
3. **Portfolio Manager**: Real-time tracking and a one-click kill-switch for all positions.
   - Run: `/manage-bots`

## Core Metrics
- **Chop Score**: Ratio of cumulative movement over absolute range. (High Score = Better for Grids).
- **Effective Leverage**: Calculated by factoring in manual "Extra Padding" for accurate liquidation prediction.
- **Geometric Grid num**: Automatically optimized to meet a minimum profit-per-step threshold.

## Configuration
Requires `.env` with:
- `OKX_API_KEY_LIVE` / `OKX_API_SECRET_LIVE`
- `OKX_API_KEY_TEST` / `OKX_API_SECRET_TEST`
- `OKX_API_PASSPHRASE`
- `OKX_TEST=true` (Toggle for Demo vs Live)

## Version
2.0.0 (Supports Geometric Grids & Safety Padding)