import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

// ==========================================
// 1. CONFIGURATION
// ==========================================
const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;

// Thresholds for the gap monitoring
const GAP_THRESHOLD = Number(process.env.GAP_THRESHOLD) || 10;
const CLOSE_THRESHOLD = Number(process.env.CLOSE_THRESHOLD) || 5;
const LEVERAGE = Number(process.env.GAP_LEVERAGE) || 10;
const POLL_INTERVAL_MS = Number(process.env.GAP_POLL_INTERVAL_MS) || 10000;
const MAX_REVERSALS = Number(process.env.MAX_REVERSALS) || 6;

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.gap-v2-state.json';

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
interface Trade {
    side: 'long' | 'short';
    entryPx: number;
    sz: number;
}
interface PairState {
    trades: Trade[];
    D_price: number;
    reversePx: number;
    targetPx: number;
    ctVal: number;
}

let activeState: Record<string, PairState> = {};

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            activeState = JSON.parse(data);
        }
    } catch (e) {
        console.error("Failed to load state", e);
        activeState = {};
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeState, null, 2));
}

// ==========================================
// 3. OKX API HELPER
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
        return { code: '-1', data: [{ sMsg: error.message }], msg: error.message };
    }
}

// ==========================================
// 4. CORE LOGIC
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
    if (sz < 1) sz = 1;
    return sz;
}

async function executeMarketOrder(instId: string, side: 'buy'|'sell', posSide: string, sz: number) {
    console.log(`\n🚀 [${instId}] Executing MARKET ${side.toUpperCase()} ${sz} contracts (posSide: ${posSide})`);
    const orderPayload = {
        instId,
        tdMode: 'isolated',
        side,
        ordType: 'market',
        posSide,
        sz: sz.toString()
    };
    const orderRes = await okxRequest('POST', '/api/v5/trade/order', orderPayload);
    if (orderRes && orderRes.code === '0' && orderRes.data && orderRes.data[0].sCode === '0') {
        console.log(`✅ Order successful.`);
        return true;
    } else {
        console.log(`❌ Order failed: ${JSON.stringify(orderRes?.data || orderRes?.msg)}`);
        return false;
    }
}

async function closeAllManual(instId: string, posMode: string) {
    console.log(`\n♻️ [${instId}] Closing all manual positions to lock PNL.`);
    if (posMode === 'net_mode') {
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'net', mgnMode: 'isolated' });
    } else {
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'long', mgnMode: 'isolated' });
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'short', mgnMode: 'isolated' });
    }
}

async function monitorGapsV2() {
    console.log(`\n🤖 Starting Gap Monitor V2 (Zone Recovery) (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`📊 GAP_THRESHOLD: ${GAP_THRESHOLD} USDT | 📉 CLOSE_THRESHOLD: ${CLOSE_THRESHOLD} USDT`);
    console.log(`⏱️ POLL INTERVAL: ${POLL_INTERVAL_MS / 1000}s | 🔄 MAX REVERSALS: ${MAX_REVERSALS}`);

    loadState();

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
    const isNetMode = posMode === 'net_mode';
    
    const res = await okxRequest('GET', '/api/v5/tradingBot/grid/orders-algo-pending?algoOrdType=contract_grid');
    if (!res || res.code !== '0') return;

    const bots = res.data;
    if (!bots || bots.length === 0) return;

    const groups: Record<string, any[]> = {};
    for (const bot of bots) {
        if (!groups[bot.instId]) groups[bot.instId] = [];
        groups[bot.instId].push(bot);
    }

    for (const instId in groups) {
        const pairBots = groups[instId];
        let totalPnl = 0;
        let worstBot = pairBots[0];
        let worstPnl = parseFloat(worstBot.totalPnl || '0');
        let longPnl = 0; let shortPnl = 0;

        for (const b of pairBots) {
            const pnl = parseFloat(b.totalPnl || '0');
            totalPnl += pnl;
            if (pnl < worstPnl) { worstPnl = pnl; worstBot = b; }
            if (b.direction.toLowerCase() === 'long') longPnl += pnl;
            else if (b.direction.toLowerCase() === 'short') shortPnl += pnl;
        }

        const gap = totalPnl < 0 ? Math.abs(totalPnl) : 0;
        const pnlImbalance = Math.abs(longPnl - shortPnl);

        const stateObj = activeState[instId];

        // SCENARIO 1: NO ACTIVE ZONE RECOVERY BUNDLE
        if (!stateObj) {
            if (gap >= GAP_THRESHOLD && pnlImbalance >= (gap * 0.6)) {
                console.log(`\n⚠️ [${instId}] Gap = ${gap.toFixed(2)} USDT. Imbalance = ${pnlImbalance.toFixed(2)}. Initiating V2 Zone Recovery!`);
                
                const instDetails = await getInstrumentDetails(instId);
                const currentPrice = await getTickerPrice(instId);
                if (!instDetails || !currentPrice) continue;

                const ctVal = parseFloat(instDetails.ctVal);
                const losingDirection = worstBot.direction.toLowerCase();
                const targetDirection = losingDirection === 'long' ? 'short' : 'long';
                
                // Base size equivalent to 1x gap threshold
                const sz = calculateContracts(GAP_THRESHOLD, currentPrice, ctVal, LEVERAGE);
                
                const side = targetDirection === 'long' ? 'buy' : 'sell';
                const posSide = isNetMode ? 'net' : targetDirection;

                const success = await executeMarketOrder(instId, side, posSide, sz);
                if (success) {
                    // D_price is the price distance that causes 'GAP_THRESHOLD' loss for this initial size.
                    const dPrice = GAP_THRESHOLD / (sz * ctVal);
                    
                    activeState[instId] = {
                        trades: [{ side: targetDirection, entryPx: currentPrice, sz }],
                        ctVal,
                        D_price: dPrice,
                        targetPx: targetDirection === 'long' ? currentPrice + dPrice : currentPrice - dPrice,
                        reversePx: targetDirection === 'long' ? currentPrice - dPrice : currentPrice + dPrice
                    };
                    saveState();
                }
            }
        } 
        
        // SCENARIO 2: ACTIVE ZONE RECOVERY BUNDLE
        else {
            const P = await getTickerPrice(instId);
            if (!P) continue;

            // Calculate theoretical bundle PNL
            let bundlePnl = 0;
            for (const t of stateObj.trades) {
                if (t.side === 'long') bundlePnl += (P - t.entryPx) * t.sz * stateObj.ctVal;
                else bundlePnl += (t.entryPx - P) * t.sz * stateObj.ctVal;
            }

            // Sub-scenario 2A: We hit our profit target!
            if (bundlePnl >= CLOSE_THRESHOLD) {
                console.log(`\n🎉 [${instId}] Bundle PNL hit +${bundlePnl.toFixed(2)} USDT (Target: ${CLOSE_THRESHOLD}). Closing Zone Recovery!`);
                await closeAllManual(instId, posMode);
                delete activeState[instId];
                saveState();
                continue;
            }

            // Sub-scenario 2B: We hit our reversal line
            const lastTrade = stateObj.trades[stateObj.trades.length - 1];
            const isLong = lastTrade.side === 'long';
            
            const hitReverse = (isLong && P <= stateObj.reversePx) || (!isLong && P >= stateObj.reversePx);

            if (hitReverse) {
                if (stateObj.trades.length >= MAX_REVERSALS) {
                    console.log(`\n💀 [${instId}] Hit MAX_REVERSALS (${MAX_REVERSALS}). Admitting defeat and closing at a loss to protect account.`);
                    await closeAllManual(instId, posMode);
                    delete activeState[instId];
                    saveState();
                    continue;
                }

                console.log(`\n🔄 [${instId}] Price hit Reversal Line (${stateObj.reversePx}). Bundle PNL: ${bundlePnl.toFixed(2)}. Initiating Reverse Layer!`);
                
                const newSide = isLong ? 'short' : 'long';
                const newReversePx = stateObj.targetPx;
                const newTargetPx = newSide === 'long' ? stateObj.reversePx + stateObj.D_price : stateObj.reversePx - stateObj.D_price;

                // What is the existing PNL at the NEW target?
                let existingPnlAtTarget = 0;
                for (const t of stateObj.trades) {
                    if (t.side === 'long') existingPnlAtTarget += (newTargetPx - t.entryPx) * t.sz * stateObj.ctVal;
                    else existingPnlAtTarget += (t.entryPx - newTargetPx) * t.sz * stateObj.ctVal;
                }

                // We need the new trade to make (CLOSE_THRESHOLD - existingPnlAtTarget) profit at the new target
                const requiredNewPnl = CLOSE_THRESHOLD - existingPnlAtTarget;
                const unitPnl = newSide === 'long' ? (newTargetPx - P) : (P - newTargetPx);

                // If unitPnl is 0 (unlikely due to D_price spacing), protect against Infinity
                let sz = 1;
                if (unitPnl > 0) {
                    sz = Math.ceil(requiredNewPnl / (unitPnl * stateObj.ctVal));
                    if (sz < 1) sz = 1;
                }

                const sideOp = newSide === 'long' ? 'buy' : 'sell';
                const posSide = isNetMode ? 'net' : newSide;

                const success = await executeMarketOrder(instId, sideOp, posSide, sz);
                if (success) {
                    activeState[instId].reversePx = newReversePx;
                    activeState[instId].targetPx = newTargetPx;
                    activeState[instId].trades.push({ side: newSide, entryPx: P, sz });
                    saveState();
                }
            }
        }
    }
}

monitorGapsV2();

export { monitorGapsV2 };
