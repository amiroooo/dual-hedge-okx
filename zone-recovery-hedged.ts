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

const SYMBOLS_RAW = process.env.ZR_SYMBOLS || 'BTC-USDT-SWAP,CFX-USDT-SWAP';
const SYMBOLS = SYMBOLS_RAW.split(',').map(s => s.trim()).filter(s => s.length > 0);

const MARGIN = Number(process.env.ZR_MARGIN) || 10;
const LEVERAGE = Number(process.env.ZR_LEVERAGE) || 5;
const TP_PCT = Number(process.env.ZR_TP_PCT) || 0.01;
const ZONE_PCT = Number(process.env.ZR_ZONE_PCT) || 0.01;
const MAX_REVERSALS = Number(process.env.ZR_MAX_REVERSALS) || 5;
const POLL_INTERVAL_MS = Number(process.env.ZR_POLL_INTERVAL_MS) || 5000;
const CLOSE_USDT_PROFIT = 0.5; // Small threshold to cover fees and profit
const FEE_PCT = 0.0005; // 0.05% estimated taker fee
const SLIPPAGE_PCT = 0.0002; // 0.02% slippage buffer

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.zr-hedged-state.json';
const PERF_LOG = 'zr-hedged-performance.json';

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
interface Leg {
    side: 'long' | 'short';
    entryPx: number;
    sz: number;
}
interface ZRState {
    ctVal: number;
    P0: number;
    E_profit: number; // Theoretical target profit in USDT
    D_tp_price: number;
    D_zone_price: number;
    P_up_line: number;
    P_down_line: number;

    legs: Leg[];
    currentReversePx: number;
    targetPx: number;
    revAlgoId: string;
    tickDecimals: number;
}

interface ManagerState {
    symbols: Record<string, ZRState>;
    mismatches: Record<string, number>; // symbol -> consecutive mismatch count
}

let activeState: ManagerState = { symbols: {}, mismatches: {} };

function round(val: number, decimals: number): number {
    return Number(val.toFixed(decimals));
}

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            activeState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (!activeState.symbols) activeState.symbols = {};
            if (!activeState.mismatches) activeState.mismatches = {};
        } catch (e) { terror("LoadState Error:", e); }
    }
}
function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeState, null, 2));
}

function tlog(...args: any[]) {
    console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}
function terror(...args: any[]) {
    console.error(`[${new Date().toLocaleTimeString()}]`, ...args);
}

function logEvent(event: any) {
    const entry = { timestamp: new Date().toISOString(), ...event };
    let history = [];
    if (fs.existsSync(PERF_LOG)) {
        try { history = JSON.parse(fs.readFileSync(PERF_LOG, 'utf8')); } catch (e) { }
    }
    history.push(entry);
    fs.writeFileSync(PERF_LOG, JSON.stringify(history, null, 2));
}

// ==========================================
// 3. OKX API HELPERS
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
        const response = await axios({
            method,
            url: `${BASE_URL}${endpoint}`,
            headers,
            data: bodyStr ? bodyStr : undefined,
            timeout: 10000
        });
        return response.data;
    } catch (error: any) {
        if (error.code === 'ECONNABORTED') return { code: '-1', msg: 'Request timed out after 10s' };
        return { code: '-1', msg: error.response?.data?.msg || error.message };
    }
}

async function getTickerPrice(instId: string): Promise<number> {
    for (let i = 0; i < 3; i++) {
        const res = await okxRequest('GET', `/api/v5/market/ticker?instId=${instId}`);
        if (res && res.code === '0' && res.data?.length > 0) {
            return parseFloat(res.data[0].last);
        }
        if (res && res.msg) {
            terror(`⚠️ [${instId}] Ticker Attempt ${i+1} failed: ${res.msg} (Code: ${res.code})`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return 0;
}

async function setAccountMode() {
    // 1. Check current mode
    const cfg = await okxRequest('GET', '/api/v5/account/config');
    if (cfg && cfg.code === '0') {
        const currentMode = cfg.data[0].posMode;
        tlog(`ℹ️ Current Account Position Mode: ${currentMode}`);
        if (currentMode === 'long_short_mode') {
            tlog("✅ Already in Hedge Mode.");
            return 'long_short_mode';
        }
    }

    // 2. Try to set it
    tlog("🔄 Attempting to switch Account to Hedge Mode (long_short_mode)...");
    const res = await okxRequest('POST', '/api/v5/account/set-position-mode', { posMode: 'long_short_mode' });
    if (res.code === '0') {
        tlog("✅ Successfully switched to Hedge Mode.");
        return 'long_short_mode';
    } else {
        terror(`\n❌ FATAL: FAILED to switch to Hedge Mode: ${res.msg}`);
        terror(`⚠️  The simultaneous Long/Short strategy CANNOT run in 'net_mode'.`);
        terror(`👉 ACTION REQUIRED:`);
        terror(`   1. Stop all grid bots on this account.`);
        terror(`   2. Cancel all pending orders (limit, trigger, etc).`);
        terror(`   3. Close all open positions.`);
        terror(`   4. Then restart this script.`);
        process.exit(1);
    }
}

async function executeOrder(instId: string, side: 'buy' | 'sell', posSide: 'long' | 'short', sz: number, tpPx?: number, slPx?: number): Promise<boolean> {
    tlog(`🚀 [${instId}] Placing order: ${side.toUpperCase()} ${sz} as ${posSide.toUpperCase()}${tpPx ? ` (TP: ${tpPx}, SL: ${slPx})` : ''}`);

    const body: any = {
        instId, tdMode: 'isolated', side, posSide, ordType: 'market', sz: sz.toString()
    };
    if (tpPx || slPx) {
        body.attachAlgoOrds = [];
        if (tpPx) body.attachAlgoOrds.push({ tpTriggerPx: tpPx.toString(), tpOrdPx: '-1' });
        if (slPx) body.attachAlgoOrds.push({ slTriggerPx: slPx.toString(), slOrdPx: '-1' });
    }

    const res = await okxRequest('POST', '/api/v5/trade/order', body);
    if (res && res.code === '0' && res.data?.[0]?.sCode === '0') {
        tlog(`✅ [${instId}] Order successful: ${res.data[0].ordId}`);
        return true;
    } else {
        const err = res.data?.[0]?.sMsg || res.msg || 'Unknown Error';
        tlog(`❌ [${instId}] Order failed: ${err}`);
        return false;
    }
}

async function closeAllPositions(instId: string) {
    tlog(`♻️ [${instId}] Closing entire bundle...`);
    await okxRequest('POST', '/api/v5/trade/close-position', { instId, mgnMode: 'isolated', posSide: 'long' });
    await okxRequest('POST', '/api/v5/trade/close-position', { instId, mgnMode: 'isolated', posSide: 'short' });
}

async function setLeverage(instId: string, lever: number): Promise<number> {
    tlog(`⚙️ [${instId}] Syncing leverage (${lever}x)...`);
    
    // 1. Fetch current leverage info to avoid redundant (and failing) calls
    const infoRes = await okxRequest('GET', `/api/v5/account/leverage-info?instId=${instId}&mgnMode=isolated`);
    const liveLeverageMap: Record<string, number> = {};
    if (infoRes && infoRes.code === '0' && infoRes.data) {
        for (const item of infoRes.data) {
            liveLeverageMap[item.posSide] = Number(item.lever);
        }
    }

    let finalLever = lever;
    const sides: ('long'|'short')[] = ['long', 'short'];
    for (const posSide of sides) {
        const current = liveLeverageMap[posSide];
        if (current === lever) {
            tlog(`✅ [${instId}] ${posSide} already at ${lever}x. Skipping.`);
            continue;
        }

        tlog(`⚙️ [${instId}] Setting ${posSide} leverage to ${lever}x...`);
        const res = await okxRequest('POST', '/api/v5/account/set-leverage', {
            instId, lever: lever.toString(), mgnMode: 'isolated', posSide
        });
        
        if (res.code !== '0') {
            terror(`⚠️ [${instId}] Failed to set leverage for ${posSide}: ${res.msg}`);
            tlog(`💡 [${instId}] Tip: If you have an active position, OKX might block leverage changes.`);
            if (current) finalLever = current; // Fallback to what we found in step 1
        } else {
            tlog(`✅ [${instId}] Leverage set to ${lever}x for ${posSide}.`);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    // Final validation
    if (liveLeverageMap['long']) finalLever = liveLeverageMap['long']; // default to existing if we skipped
    return finalLever;
}

async function placeTriggerOrder(instId: string, side: 'buy'|'sell', posSide: 'long'|'short', triggerPx: number, sz: number): Promise<string | null> {
    tlog(`🚀 [${instId}] Placing Trigger Order: ${side.toUpperCase()} ${sz} at ${triggerPx} (posSide: ${posSide})`);
    const res = await okxRequest('POST', '/api/v5/trade/order-algo', {
        instId, tdMode: 'isolated', side, posSide, ordType: 'trigger', triggerPx: triggerPx.toString(), orderPx: '-1', sz: sz.toString()
    });
    if (res && res.code === '0' && res.data?.[0]?.algoId) return res.data[0].algoId;
    terror(`❌ [${instId}] Trigger Order failed:`, res.msg || res.data?.[0]?.sMsg);
    return null;
}

async function cancelAlgoOrder(instId: string, algoId: string) {
    if (!algoId || algoId === 'manual') return;
    await okxRequest('POST', '/api/v5/trade/cancel-algos', [{ instId, algoId }]);
}

async function cancelAllAlgoOrders(instId: string) {
    tlog(`🧹 [${instId}] Checking for all pending Algo orders...`);
    // Full list of OKX algo types
    const types = ['trigger', 'tpsl', 'stop', 'trailing_stop', 'move_order_stop', 'iceberg', 'twap'];
    for (const type of types) {
        const res = await okxRequest('GET', `/api/v5/trade/orders-algo-pending?instId=${instId}&algoOrdType=${type}`);
        if (res && res.code === '0' && res.data?.length > 0) {
            tlog(`🧹 [${instId}] Found ${res.data.length} ${type} orders. Canceling...`);
            const algos = res.data.map((a: any) => ({ instId: a.instId, algoId: a.algoId }));
            await okxRequest('POST', '/api/v5/trade/cancel-algos', algos);
        }
    }

    // Check for Grid Bots (Contract Grid specifically as it's common for SWAP)
    const gridTypes = ['grid', 'contract_grid'];
    for (const gType of gridTypes) {
        const grid = await okxRequest('GET', `/api/v5/grid/orders-algo-pending?instId=${instId}&algoOrdType=${gType}`);
        if (grid && grid.code === '0' && grid.data?.length > 0) {
            terror(`⚠️ [${instId}] ACTIVE ${gType.toUpperCase()} DETECTED! This will block leverage changes.`);
            terror(`👉 ACTION: Please stop all Grid Bots for ${instId} in the OKX App/Web.`);
        }
    }

    // Small pause to allow OKX state to update
    await new Promise(r => setTimeout(r, 1000));
}

async function checkAlgoStatus(instId: string, algoId: string): Promise<string | null> {
    // Check pending
    let res = await okxRequest('GET', `/api/v5/trade/orders-algo-pending?instId=${instId}&algoId=${algoId}&algoOrdType=trigger`);
    if (res && res.code === '0' && res.data?.length > 0) return 'live';
    
    // Check history
    res = await okxRequest('GET', `/api/v5/trade/orders-algo-history?instId=${instId}&algoId=${algoId}&algoOrdType=trigger`);
    if (res && res.code === '0' && res.data?.length > 0) return res.data[0].state; // 'effective', 'canceled', etc.
    return null;
}

async function verifyBundleConsistency(sym: string, state: ZRState): Promise<{ consistent: boolean, liveUpl: number }> {
    const res = await okxRequest('GET', `/api/v5/account/positions?instId=${sym}`);
    if (!res || res.code !== '0') return { consistent: true, liveUpl: 0 }; // Fail safe

    let liveLong = 0;
    let liveShort = 0;
    let liveUpl = 0;
    let expectedLong = 0;
    let expectedShort = 0;
    for (const leg of state.legs) {
        if (leg.side === 'long') expectedLong += leg.sz;
        else expectedShort += leg.sz;
    }

    for (const pos of res.data) {
        if (pos.mgnMode !== 'isolated') continue; // Only count our isolated positions
        const sideUpl = parseFloat(pos.upl || '0');
        liveUpl += sideUpl;

        if (pos.posSide === 'long') liveLong += parseInt(pos.pos);
        if (pos.posSide === 'short') liveShort += parseInt(pos.pos);
    }

    if (liveLong !== expectedLong || liveShort !== expectedShort) {
        tlog(`⚠️ [${sym}] Consistency Mismatch! OKX: L:${liveLong} S:${liveShort} | JSON: L:${expectedLong} S:${expectedShort}`);
        if (res.data?.length > 0) {
            tlog(`🔍 [${sym}] Raw OKX Pos Data: ${JSON.stringify(res.data.map((p: any) => ({ 
                instId: p.instId, posSide: p.posSide, pos: p.pos, mgnMode: p.mgnMode 
            })))}`);
        } else {
            tlog(`🔍 [${sym}] OKX reports ZERO positions.`);
        }
        return { consistent: false, liveUpl };
    }
    return { consistent: true, liveUpl };
}

// ==========================================
// 4. CORE HEDGED LOGIC
// ==========================================

async function runHedgedManager() {
    tlog(`\n🛡️ HEDGED ZONE RECOVERY MANAGER (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    tlog(`📈 SYMBOLS: ${SYMBOLS.join(', ')}`);
    if (SYMBOLS.length === 0) {
        tlog("❌ CRITICAL: No symbols found in ZR_SYMBOLS. Please check your .env file.");
        return;
    }

    await setAccountMode();
    loadState();

    tlog("⚙️ Syncing leverage and cleaning orders for all symbols...");
    for (const sym of SYMBOLS) {
        await cancelAllAlgoOrders(sym);
        await setLeverage(sym, LEVERAGE);
    }

    while (true) {
        for (const sym of SYMBOLS) {
            try { await processSymbolHedged(sym); }
            catch (e) { terror(`Error on ${sym}:`, e); }
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

async function processSymbolHedged(sym: string) {
    const state = activeState.symbols[sym];
    const P = await getTickerPrice(sym);
    if (!P) {
        tlog(`⚠️ [${sym}] Price fetch failed. skipping...`);
        return;
    }

    if (!state) {
        tlog(`ℹ️ [${sym}] No state found. Initializing cycle...`);
        const res = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${sym}`);
        if (!res || res.code !== '0' || !res.data?.[0]) {
            tlog(`❌ [${sym}] Failed to fetch instrument details for ${sym}: ${JSON.stringify(res)}`);
            return;
        }
        const ctVal = parseFloat(res.data[0].ctVal);
        const tickSz = res.data[0].tickSz;
        
        // 0. Clean the slate first (Cancel all triggers/SLs to allow leverage change)
        await cancelAllAlgoOrders(sym);

        // 1. Set Leverage and capture ACTUAL leverage used
        const actualLever = await setLeverage(sym, LEVERAGE);

        const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;
        tlog(`ℹ️ [${sym}] ctVal: ${ctVal}, Price: ${P}, Decimals: ${tickDecimals}, Leverage: ${actualLever}x`);

        const side = Math.random() > 0.5 ? 'long' : 'short';
        const sz1 = Math.max(1, Math.floor((MARGIN * actualLever) / (P * ctVal)));
        tlog(`ℹ️ [${sym}] Target Side: ${side}, Target Size: ${sz1}`);

        const D_tp_price = P * TP_PCT;
        const D_zone_price = P * ZONE_PCT;

        const P_up_line = side === 'long' ? P + D_tp_price : P + D_zone_price;
        const P_down_line = side === 'long' ? P - D_zone_price : P - D_tp_price;

        const tpPx = side === 'long' ? round(P + D_tp_price, tickDecimals) : round(P - D_tp_price, tickDecimals);
        const slPx = side === 'long' ? round(P - (D_tp_price * 10), tickDecimals) : round(P + (D_tp_price * 10), tickDecimals); // 10x TP distance (Far Safety SL)
        const success = await executeOrder(sym, side === 'long' ? 'buy' : 'sell', side, sz1, tpPx, slPx);
        if (success) {
            const nextSide = side === 'long' ? 'short' : 'long';
            const reversePx = side === 'long' ? P - D_zone_price : P + D_zone_price;
            const targetPx = side === 'long' ? P + D_tp_price : P - D_tp_price;

            // Pre-calculate Leg 2 size
            const newTargetPx = nextSide === 'short' ? P - D_zone_price - D_tp_price : P + D_zone_price + D_tp_price;
            const currentPnlAtNewTarget = (side === 'long' ? (newTargetPx - P) : (P - newTargetPx)) * sz1 * ctVal;
            
            // Add Fee Buffer: Estimated cost to open this leg and close the entire bundle eventually
            const estimatedFees = (sz1 * ctVal * P * FEE_PCT) * 2; // Open + Close of this leg
            const neededFromNewLeg = (D_tp_price * sz1 * ctVal + CLOSE_USDT_PROFIT + estimatedFees) - currentPnlAtNewTarget;
            const distance = Math.abs(newTargetPx - reversePx) * (1 - SLIPPAGE_PCT); // Assume slightly less distance due to slippage
            const sz2 = Math.ceil(neededFromNewLeg / (distance * ctVal));

            const revAlgoId = await placeTriggerOrder(sym, nextSide === 'long' ? 'buy' : 'sell', nextSide, reversePx, sz2);

            activeState.symbols[sym] = {
                ctVal, P0: P, E_profit: D_tp_price * sz1 * ctVal,
                D_tp_price, D_zone_price, P_up_line, P_down_line,
                legs: [{ side, entryPx: P, sz: sz1 }],
                currentReversePx: reversePx,
                targetPx,
                revAlgoId: revAlgoId || 'manual',
                tickDecimals
            };
            saveState();
            logEvent({ sym, action: 'start', details: { side, entryPx: P, sz: sz1, tpPx, slPx, revAlgoId } });
        }
    } else {
        // 1. REVERSAL TRIGGER MONITOR (Check logic first so state is updated before consistency)
        const revStatus = await checkAlgoStatus(sym, state.revAlgoId);
        const lastLeg = state.legs[state.legs.length - 1];
        const isLong = lastLeg.side === 'long';
        
        let shouldProcessReversal = false;
        if (revStatus === 'effective') {
            shouldProcessReversal = true;
        } else if (revStatus === null && state.revAlgoId === 'manual') {
            if ((isLong && P <= state.currentReversePx) || (!isLong && P >= state.currentReversePx)) {
                shouldProcessReversal = true;
            }
        }

        if (shouldProcessReversal) {
            if (state.legs.length >= MAX_REVERSALS) {
                tlog(`\n💀 [${sym}] Max Reversals Hit. Closing at loss.`);
                await closeAllPositions(sym);
                delete activeState.symbols[sym];
                saveState();
                return;
            }

            tlog(`\n🔄 [${sym}] REVERSAL DETECTED! (Status: ${revStatus || 'polling'})...`);
            const newSide = isLong ? 'short' : 'long';
            const tickDecimals = state.tickDecimals;
            
            const newTargetPx = Number((newSide === 'short' ? state.P_down_line - state.D_tp_price : state.P_up_line + state.D_tp_price).toFixed(tickDecimals));
            const newReversePx = Number((newSide === 'short' ? state.P_up_line : state.P_down_line).toFixed(tickDecimals));

            let currentPnlAtNewTarget = 0;
            for (const leg of state.legs) {
                if (leg.side === 'long') currentPnlAtNewTarget += (newTargetPx - leg.entryPx) * leg.sz * state.ctVal;
                else currentPnlAtNewTarget += (leg.entryPx - newTargetPx) * leg.sz * state.ctVal;
            }
            const totalSzCurrently = state.legs.reduce((acc, l) => acc + l.sz, 0);
            const estFeesCumulative = (totalSzCurrently * state.ctVal * state.currentReversePx * FEE_PCT) * 2;
            const neededFromNewLeg = (state.E_profit + CLOSE_USDT_PROFIT + estFeesCumulative) - currentPnlAtNewTarget;
            const distance = Math.abs(newTargetPx - state.currentReversePx) * (1 - SLIPPAGE_PCT);
            const sz = Math.ceil(neededFromNewLeg / (distance * state.ctVal));

            state.legs.push({ side: newSide, entryPx: state.currentReversePx, sz });
            
            const nextSide = newSide === 'long' ? 'short' : 'long';
            const nextTargetPx = nextSide === 'short' ? state.P_down_line - state.D_tp_price : state.P_up_line + state.D_tp_price;
            const pnlAtNextTarget = state.legs.reduce((acc, l) => {
                const diff = l.side === 'long' ? (nextTargetPx - l.entryPx) : (l.entryPx - nextTargetPx);
                return acc + (diff * l.sz * state.ctVal);
            }, 0);

            const totalSzSoFar = state.legs.reduce((acc, l) => acc + l.sz, 0);
            const estimatedFeesTotal = (totalSzSoFar * state.ctVal * state.currentReversePx * FEE_PCT) * 2;
            const neededNext = (state.E_profit + CLOSE_USDT_PROFIT + estimatedFeesTotal) - pnlAtNextTarget;
            const nextDist = Math.abs(nextTargetPx - newReversePx) * (1 - SLIPPAGE_PCT);
            const szNext = Math.ceil(neededNext / (nextDist * state.ctVal));

            const nextAlgoId = await placeTriggerOrder(sym, nextSide === 'long' ? 'buy' : 'sell', nextSide, newReversePx, szNext);

            state.targetPx = newTargetPx;
            state.currentReversePx = newReversePx;
            state.revAlgoId = nextAlgoId || 'manual';
            saveState();
            logEvent({ sym, action: 'reversal', details: { side: newSide, entryPx: state.currentReversePx, sz, count: state.legs.length, nextAlgoId } });
        }

        // 2. CONSISTENCY CHECK (3 Strikes)
        const { consistent, liveUpl } = await verifyBundleConsistency(sym, state);
        if (!consistent) {
            const count = (activeState.mismatches[sym] || 0) + 1;
            activeState.mismatches[sym] = count;
            if (count < 3) {
                tlog(`⚠️ [${sym}] Consistency mismatch detected (${count}/3). Retrying in next loop...`);
                return;
            } else {
                tlog(`❌ [${sym}] Local state out of sync for 3 consecutive loops. FORCING CLOSE ALL.`);
                await cancelAllAlgoOrders(sym);
                await closeAllPositions(sym);
                delete activeState.symbols[sym];
                delete activeState.mismatches[sym];
                saveState();
                return;
            }
        }
        if (activeState.mismatches[sym]) delete activeState.mismatches[sym];

        // 3. MONITOR BUNDLE PNL
        const totalSz = state.legs.reduce((acc, l) => acc + l.sz, 0);
        const feesPaidEst = (totalSz * state.ctVal * P * FEE_PCT) * 2;
        const bundlePnlNet = liveUpl - feesPaidEst;

        if (bundlePnlNet >= state.E_profit + CLOSE_USDT_PROFIT) {
            tlog(`\n🎉 [${sym}] Bundle Profit Hit (Net): +$${bundlePnlNet.toFixed(2)} USDT (UPL: ${liveUpl.toFixed(2)}, Fees: -${feesPaidEst.toFixed(2)}). Closing all legs.`);
            await cancelAlgoOrder(sym, state.revAlgoId);
            await closeAllPositions(sym);
            delete activeState.symbols[sym];
            saveState();
            logEvent({ sym, action: 'exit_win', details: { finalPnlNet: bundlePnlNet, legs: state.legs.length } });
            return;
        }
    }
}

process.on('unhandledRejection', (reason, promise) => {
    terror('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    terror('❌ Uncaught Exception:', err);
});

runHedgedManager();
