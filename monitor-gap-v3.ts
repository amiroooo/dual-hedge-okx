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

const GAP_THRESHOLD = Number(process.env.GAP_THRESHOLD) || 10;
const POLL_INTERVAL_MS = Number(process.env.GAP_POLL_INTERVAL_MS) || 10000;
const MAX_REVERSALS = Number(process.env.MAX_REVERSALS) || 6;
const LEVERAGE = Number(process.env.GAP_LEVERAGE) || 10;

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.gap-v3-state.json';

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
    ctVal: number;
    initialGap: number;
    targetNode: 'up' | 'down';
    P_max: number;
    P_min: number;
    P_mid: number;
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

async function executeMarketOrder(instId: string, side: 'buy' | 'sell', posSide: string, sz: number) {
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

function calcTargetSz(target: 'up' | 'down', initialGap: number, ctVal: number, P: number, P_max: number, P_min: number, trades: Trade[]): number {
    const P_target = target === 'up' ? P_max : P_min;
    let existingPnl = 0;
    for (const t of trades) {
        if (t.side === 'long') existingPnl += (P_target - t.entryPx) * t.sz * ctVal;
        else existingPnl += (t.entryPx - P_target) * t.sz * ctVal;
    }
    const requiredPnl = initialGap - existingPnl;
    const unitPnl = target === 'up' ? (P_target - P) : (P - P_target);

    if (unitPnl <= 0) return 0; // Already hit target

    let sz = Math.ceil(requiredPnl / (unitPnl * ctVal));
    return sz < 1 ? 1 : sz;
}

async function monitorGapsV3() {
    console.log(`\n🤖 Starting Gap Monitor V3 (Grid-Bounded Null Recovery) (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`📊 GAP_THRESHOLD: ${GAP_THRESHOLD} USDT`);
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

        let P_max = parseFloat(pairBots[0].maxPx || '0');
        let P_min = parseFloat(pairBots[0].minPx || '0');

        for (const b of pairBots) {
            totalPnl += parseFloat(b.totalPnl || '0');
            const bMax = parseFloat(b.maxPx || '0');
            const bMin = parseFloat(b.minPx || '0');
            if (bMax > P_max) P_max = bMax;
            if (bMin < P_min) P_min = bMin;
        }

        const P_mid = (P_max + P_min) / 2;
        const gap = totalPnl < 0 ? Math.abs(totalPnl) : 0;
        const P = await getTickerPrice(instId);
        if (!P) continue;

        const stateObj = activeState[instId];

        // SCENARIO 1: NO ACTIVE V3 RECOVERY BUNDLE
        if (!stateObj) {
            // Check 70% conditions
            const P_up70 = P_mid + 0.7 * (P_max - P_mid);
            const P_down70 = P_mid - 0.7 * (P_mid - P_min);

            const isUpTrend = P >= P_up70;
            const isDownTrend = P <= P_down70;

            if (gap >= GAP_THRESHOLD && (isUpTrend || isDownTrend)) {
                console.log(`\n⚠️ [${instId}] Gap = ${gap.toFixed(2)} USDT (>= ${GAP_THRESHOLD}). Price crossed 70% mark. Initiating V3 Recovery!`);

                const instDetails = await getInstrumentDetails(instId);
                if (!instDetails) continue;

                const ctVal = parseFloat(instDetails.ctVal);
                const targetNode = isUpTrend ? 'up' : 'down';
                const tradeSide = isUpTrend ? 'long' : 'short';

                let sz = calcTargetSz(targetNode, gap, ctVal, P, P_max, P_min, []);
                if (sz === 0) continue;

                const side = tradeSide === 'long' ? 'buy' : 'sell';
                const posSide = isNetMode ? 'net' : tradeSide;

                const requiredMargin = (sz * ctVal * P) / LEVERAGE;
                const balRes = await okxRequest('GET', '/api/v5/account/balance');
                const usdtDetails = balRes?.data?.[0]?.details?.find((d: any) => d.ccy === 'USDT');
                const availBal = usdtDetails ? parseFloat(usdtDetails.availBal || '0') : 0;

                if (availBal < requiredMargin * 1.05) {
                    console.log(`\n❌ Insufficient liquidity! Need ~$${requiredMargin.toFixed(2)} USDT to hedge, but wallet only has $${availBal.toFixed(2)} USDT. Skipping until funds available.`);
                    continue;
                }

                const success = await executeMarketOrder(instId, side, posSide, sz);
                if (success) {
                    activeState[instId] = {
                        trades: [{ side: tradeSide, entryPx: P, sz }],
                        ctVal,
                        initialGap: gap,
                        targetNode,
                        P_max,
                        P_min,
                        P_mid
                    };
                    saveState();
                }
            }
        }

        // SCENARIO 2: ACTIVE V3 RECOVERY BUNDLE
        else {
            let bundlePnl = 0;
            for (const t of stateObj.trades) {
                if (t.side === 'long') bundlePnl += (P - t.entryPx) * t.sz * stateObj.ctVal;
                else bundlePnl += (t.entryPx - P) * t.sz * stateObj.ctVal;
            }

            // Sub-scenario 2A: We hit our profit target / null barrier!
            // Null barrier is considered hit if bundlePnl > initialGap OR price crosses the boundary
            const hitEndUp = stateObj.targetNode === 'up' && P >= stateObj.P_max;
            const hitEndDown = stateObj.targetNode === 'down' && P <= stateObj.P_min;

            if (hitEndUp || hitEndDown || bundlePnl >= stateObj.initialGap) {
                console.log(`\n🎉 [${instId}] Target Reached! PNL: +${bundlePnl.toFixed(2)} USDT (Target: ${stateObj.initialGap.toFixed(2)}). Nulling gap!`);
                await closeAllManual(instId, posMode);
                delete activeState[instId];
                saveState();
                continue;
            }

            // Sub-scenario 2B: We hit our reversal line (P_mid)
            const crossDownward = stateObj.targetNode === 'up' && P <= stateObj.P_mid;
            const crossUpward = stateObj.targetNode === 'down' && P >= stateObj.P_mid;

            if (crossDownward || crossUpward) {
                if (stateObj.trades.length >= MAX_REVERSALS) {
                    console.log(`\n💀 [${instId}] Hit MAX_REVERSALS (${MAX_REVERSALS}). Admitting defeat and closing at a loss to protect account.`);
                    await closeAllManual(instId, posMode);
                    delete activeState[instId];
                    saveState();
                    continue;
                }

                console.log(`\n🔄 [${instId}] Price hit Reversal Line (Mid: ${stateObj.P_mid}). Bundle PNL: ${bundlePnl.toFixed(2)}. Initiating Reverse Layer!`);

                const newTargetNode = crossDownward ? 'down' : 'up';
                const tradeSide = newTargetNode === 'up' ? 'long' : 'short';

                let sz = calcTargetSz(
                    newTargetNode,
                    stateObj.initialGap,
                    stateObj.ctVal,
                    P,
                    stateObj.P_max,
                    stateObj.P_min,
                    stateObj.trades
                );

                if (sz > 0) {
                    const sideOp = tradeSide === 'long' ? 'buy' : 'sell';
                    const posSide = isNetMode ? 'net' : tradeSide;

                    const requiredMargin = (sz * stateObj.ctVal * P) / LEVERAGE;
                    const balRes = await okxRequest('GET', '/api/v5/account/balance');
                    const usdtDetails = balRes?.data?.[0]?.details?.find((d: any) => d.ccy === 'USDT');
                    const availBal = usdtDetails ? parseFloat(usdtDetails.availBal || '0') : 0;

                    if (availBal < requiredMargin * 1.05) {
                        console.log(`\n❌ Insufficient liquidity for reversal! Need ~$${requiredMargin.toFixed(2)} USDT, but wallet only has $${availBal.toFixed(2)} USDT. Skipping...`);
                        continue;
                    }

                    const success = await executeMarketOrder(instId, sideOp, posSide, sz);
                    if (success) {
                        activeState[instId].targetNode = newTargetNode;
                        activeState[instId].trades.push({ side: tradeSide, entryPx: P, sz });
                        saveState();
                    }
                }
            }
        }
    }
}

monitorGapsV3();

export { monitorGapsV3 };
