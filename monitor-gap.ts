import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

// ==========================================
// 1. CONFIGURATION
// ==========================================
const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;

// Thresholds for the gap monitoring
const GAP_THRESHOLD = Number(process.env.GAP_THRESHOLD) || 4;
const CLOSE_THRESHOLD = Number(process.env.CLOSE_THRESHOLD) || 2;
const LEVERAGE = Number(process.env.GAP_LEVERAGE) || 10;
const POLL_INTERVAL_MS = Number(process.env.GAP_POLL_INTERVAL_MS) || 10000;

const BASE_URL = 'https://www.okx.com';

// ==========================================
// 2. OKX API HELPER
// ==========================================
async function okxRequest(method: string, endpoint: string, bodyObj: any = null) {
    const timestamp = new Date().toISOString();
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const preHash = timestamp + method.toUpperCase() + endpoint + bodyStr;
    const signature = crypto.createHmac('sha256', API_SECRET).update(preHash).digest('base64');

    const headers: Record<string, string> = {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': API_PASSPHRASE,
        'Content-Type': 'application/json',
    };
    if (IS_SIMULATED) headers['x-simulated-trading'] = '1';

    try {
        const response = await axios({ method, url: `${BASE_URL}${endpoint}`, headers, data: bodyStr ? bodyStr : undefined });
        return response.data;
    } catch (error: any) {
        console.error(`\n❌ OKX API Error [${endpoint}]:`);
        console.error(error.response?.data || error.message);
        return null;
    }
}

// ==========================================
// 3. CORE LOGIC
// ==========================================

async function getInstrumentDetails(instId: string) {
    const res = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
    if (res && res.code === '0' && res.data.length > 0) {
        return res.data[0];
    }
    return null;
}

async function getTickerPrice(instId: string): Promise<number> {
    const res = await okxRequest('GET', `/api/v5/market/ticker?instId=${instId}`);
    if (res && res.code === '0' && res.data.length > 0) {
        return parseFloat(res.data[0].last);
    }
    return 0;
}



function calculateContracts(marginUsdt: number, price: number, ctVal: number, leverage: number): number {
    const notional = marginUsdt * leverage;
    const contractValue = price * ctVal;
    let sz = Math.floor(notional / contractValue);
    if (sz < 1) sz = 1; // Always buy at least 1 contract if triggered
    return sz;
}

async function monitorGaps() {
    console.log(`\n🤖 Starting Gap Monitor (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`📊 GAP_THRESHOLD: ${GAP_THRESHOLD} USDT`);
    console.log(`📉 CLOSE_THRESHOLD: ${CLOSE_THRESHOLD} USDT`);
    console.log(`⚙️ LEVERAGE: ${LEVERAGE}x`);
    console.log(`⏱️ POLL INTERVAL: ${POLL_INTERVAL_MS / 1000} seconds`);

    let posMode = 'long_short_mode';
    const cfgRes = await okxRequest('GET', '/api/v5/account/config');
    if (cfgRes && cfgRes.code === '0') {
        posMode = cfgRes.data[0].posMode;
        console.log(`⚙️ POSITION MODE: ${posMode}`);
    }

    while (true) {
        try {
            await runIteration(posMode);
        } catch (error) {
            console.error(`\n❌ Error during iteration:`, error);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

async function runIteration(posMode: string) {
    // 1. Fetch active grid bots
    const res = await okxRequest('GET', '/api/v5/tradingBot/grid/orders-algo-pending?algoOrdType=contract_grid');
    if (!res || res.code !== '0') return;

    const bots = res.data;
    if (!bots || bots.length === 0) return;

    // Group by pair
    const groups: Record<string, any[]> = {};
    for (const bot of bots) {
        if (!groups[bot.instId]) groups[bot.instId] = [];
        groups[bot.instId].push(bot);
    }

    // Process each pair
    for (const instId in groups) {
        const pairBots = groups[instId];
        let totalPnl = 0;
        let worstBot = pairBots[0];
        let worstPnl = parseFloat(worstBot.totalPnl || '0');

        let longPnl = 0;
        let shortPnl = 0;

        for (const b of pairBots) {
            const pnl = parseFloat(b.totalPnl || '0');
            totalPnl += pnl;

            if (pnl < worstPnl) {
                worstPnl = pnl;
                worstBot = b;
            }
            if (b.direction.toLowerCase() === 'long') longPnl += pnl;
            else if (b.direction.toLowerCase() === 'short') shortPnl += pnl;
        }

        const gap = totalPnl < 0 ? Math.abs(totalPnl) : 0;
        const pnlImbalance = Math.abs(longPnl - shortPnl);

        // Fetch manual positions
        const posRes = await okxRequest('GET', `/api/v5/account/positions?instId=${instId}`);
        let currentPositions = [];
        if (posRes && posRes.code === '0') {
            currentPositions = posRes.data;
        }

        const isNetMode = posMode === 'net_mode';

        // Logic A: Gap is large enough to warrant opening extra positions AND there is a clear loser
        if (gap >= GAP_THRESHOLD && pnlImbalance >= (gap * 0.6)) {
            // Hedge logic: If Short bot is causing the loss (price going up), open Long.
            const losingDirection = worstBot.direction.toLowerCase();
            const targetDirection = losingDirection === 'long' ? 'short' : 'long';
            const orderPosSide = isNetMode ? 'net' : targetDirection;

            // Required units of 10 USDT
            const requiredUnits = Math.floor(gap / GAP_THRESHOLD);
            const targetMargin = requiredUnits * GAP_THRESHOLD;

            // Check how much margin we currently have in this direction as manual position
            let existingPos;
            if (isNetMode) {
                existingPos = currentPositions.find((p: any) => p.posSide === 'net' && (targetDirection === 'long' ? parseFloat(p.pos) > 0 : parseFloat(p.pos) < 0));
            } else {
                existingPos = currentPositions.find((p: any) => p.posSide === targetDirection && parseFloat(p.pos) > 0);
            }
            const currentMargin = existingPos ? parseFloat(existingPos.margin || existingPos.imr || '0') : 0;

            if (currentMargin < targetMargin - 2) { // 2 USDT buffer to prevent micro-buys due to rounding
                const marginToAdd = targetMargin - currentMargin;
                console.log(`\n⚠️ [${instId}] Gap = ${gap.toFixed(2)} USDT (Worst: ${targetDirection.toUpperCase()}). Needed Margin: $${targetMargin}, Current: $${currentMargin.toFixed(2)}. Adding $${marginToAdd.toFixed(2)} limit...`);

                // Fetch instrument details
                const instDetails = await getInstrumentDetails(instId);
                const currentPrice = await getTickerPrice(instId);
                if (!instDetails || currentPrice === 0) {
                    console.log(`❌ Failed to fetch details for ${instId}`);
                    continue;
                }

                const ctVal = parseFloat(instDetails.ctVal);
                const sz = calculateContracts(marginToAdd, currentPrice, ctVal, LEVERAGE);

                // Leverage is already set by the grid bots originally, no need to set it again.

                // Place market order
                const side = targetDirection === 'long' ? 'buy' : 'sell';
                const orderPayload = {
                    instId,
                    tdMode: 'isolated',
                    side,
                    ordType: 'market',
                    posSide: orderPosSide,
                    sz: sz.toString()
                };

                const orderRes = await okxRequest('POST', '/api/v5/trade/order', orderPayload);
                if (orderRes && orderRes.code === '0' && orderRes.data && orderRes.data[0].sCode === '0') {
                    console.log(`✅ Opened ${sz} contracts of ${targetDirection.toUpperCase()} to fill gap.`);
                } else {
                    console.log(`❌ Failed to open position:\n${JSON.stringify(orderRes, null, 2)}`);
                }
            }
        }

        // Logic B: Gap has reduced significantly, close our manual positions
        else if (gap < CLOSE_THRESHOLD || totalPnl > 0) {
            // Check if we have any manual positions to close
            for (const p of currentPositions) {
                const posQty = parseFloat(p.pos);
                if (posQty !== 0) {
                    console.log(`\n♻️ [${instId}] Gap reduced to ${gap.toFixed(2)} USDT. Closing manual position (${p.posSide}).`);
                    const closePayload = {
                        instId,
                        posSide: p.posSide,
                        mgnMode: 'isolated'
                    };
                    const closeRes = await okxRequest('POST', '/api/v5/trade/close-position', closePayload);
                    if (closeRes && closeRes.code === '0') {
                        console.log(`✅ Closed manual ${p.posSide} position successfully.`);
                    } else {
                        console.log(`❌ Failed to close position: ${closeRes?.msg}`);
                    }
                }
            }
        }
    }
}

// Start immediately when the script is run directly
monitorGaps();

export { monitorGaps };
