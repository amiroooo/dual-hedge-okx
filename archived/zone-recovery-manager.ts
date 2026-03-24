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

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.zr-manager-state.json';
const PERF_LOG = 'zr-performance.json';
const TEXT_LOG = 'zr-events.log';

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
interface ZRState {
    ctVal: number;
    P0: number;
    E_profit: number;
    D_tp_price: number;
    D_zone_price: number;
    P_up_line: number;
    P_down_line: number;

    currentSide: 'long' | 'short';
    currentEntryPx: number;
    currentTargetPx: number;
    currentReversePx: number;
    
    currentNetSz: number;
    totalRealizedLoss: number;
    reversalsCount: number;

    tpOrdId: string;
    revAlgoId: string;
}

interface ManagerState {
    symbols: Record<string, ZRState>;
}

let activeState: ManagerState = { symbols: {} };

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            activeState = JSON.parse(data);
            if (!activeState.symbols) activeState.symbols = {};
        }
    } catch (e) {
        console.error("Failed to load state", e);
        activeState = { symbols: {} };
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(activeState, null, 2));
}

function logEvent(event: any) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, ...event };
    
    // JSON log for parsing
    let history = [];
    if (fs.existsSync(PERF_LOG)) {
        try { history = JSON.parse(fs.readFileSync(PERF_LOG, 'utf8')); } catch (e) {}
    }
    history.push(entry);
    fs.writeFileSync(PERF_LOG, JSON.stringify(history, null, 2));

    // Text log for quick viewing
    const logLine = `[${timestamp}] [${event.sym}] ${event.action.toUpperCase()} | ${JSON.stringify(event.details)}\n`;
    fs.appendFileSync(TEXT_LOG, logLine);
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
        return { code: '-1', data: [{ sMsg: error.response?.data?.msg || error.message }], msg: error.message };
    }
}

async function getInstrumentDetails(instId: string) {
    const res = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
    if (res && res.code === '0' && res.data.length > 0) return res.data[0];
    return null;
}

async function getTickerPrice(instId: string): Promise<number> {
    const res = await okxRequest('GET', `/api/v5/market/ticker?instId=${instId}`);
    if (res && res.code === '0' && res.data.length > 0) return parseFloat(res.data[0].last);
    return 0;
}

function calculateContracts(marginUsdt: number, price: number, ctVal: number, leverage: number): number {
    const notional = marginUsdt * leverage;
    let sz = Math.floor(notional / (price * ctVal));
    return sz < 1 ? 1 : sz;
}

// ==========================================
// 4. OKX ORDER EXECUTORS
// ==========================================

async function placeMarketOrder(instId: string, side: 'buy'|'sell', sz: number): Promise<boolean> {
    const res = await okxRequest('POST', '/api/v5/trade/order', {
        instId, tdMode: 'isolated', side, ordType: 'market', posSide: 'net', sz: sz.toString()
    });
    return res && res.code === '0' && res.data && res.data[0].sCode === '0';
}

async function placeLimitOrder(instId: string, side: 'buy'|'sell', px: number, sz: number): Promise<string | null> {
    const res = await okxRequest('POST', '/api/v5/trade/order', {
        instId, tdMode: 'isolated', side, ordType: 'limit', px: px.toString(), posSide: 'net', sz: sz.toString()
    });
    if (res && res.code === '0' && res.data && res.data[0].sCode === '0') return res.data[0].ordId;
    console.error(`[${instId}] Limit Error:`, res?.data);
    return null;
}

async function placeTriggerOrder(instId: string, side: 'buy'|'sell', triggerPx: number, sz: number): Promise<string | null> {
    const res = await okxRequest('POST', '/api/v5/trade/order-algo', {
        instId, tdMode: 'isolated', side, ordType: 'trigger', triggerPx: triggerPx.toString(), orderPx: '-1', posSide: 'net', sz: sz.toString()
    });
    if (res && res.code === '0' && res.data && res.data[0].sCode === '0') return res.data[0].algoId;
    console.error(`[${instId}] Algo Error:`, res?.data);
    return null;
}

async function cancelOrder(instId: string, ordId: string) {
    if (!ordId) return;
    await okxRequest('POST', '/api/v5/trade/cancel-order', { instId, ordId });
}

async function cancelAlgoOrder(instId: string, algoId: string) {
    if (!algoId) return;
    await okxRequest('POST', '/api/v5/trade/cancel-algos', [{ instId, algoId }]);
}

async function checkOrderStatus(instId: string, ordId: string): Promise<string | null> {
    const res = await okxRequest('GET', `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
    if (res && res.code === '0' && res.data.length > 0) return res.data[0].state;
    return null;
}

async function checkAlgoOrderStatus(instId: string, algoId: string): Promise<string | null> {
    // First check pending
    let res = await okxRequest('GET', `/api/v5/trade/orders-algo-pending?instId=${instId}&algoId=${algoId}&algoOrdType=trigger`);
    if (res && res.code === '0' && res.data.length > 0) return res.data[0].state; // likely 'live'
    
    // If not in pending, check history
    res = await okxRequest('GET', `/api/v5/trade/orders-algo-history?instId=${instId}&algoId=${algoId}&algoOrdType=trigger`);
    if (res && res.code === '0' && res.data.length > 0) return res.data[0].state; // likely 'effective' or 'canceled'
    return null;
}

async function closeAllNet(instId: string) {
    await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'net', mgnMode: 'isolated' });
}

// ==========================================
// 5. CORE MANAGER LOGIC
// ==========================================

async function runZoneManager() {
    console.log(`\n🤖 ZONE RECOVERY ORDER MANAGER (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`📈 SYMBOLS: ${SYMBOLS.join(', ')}`);
    console.log(`⏱️ POLL INTERVAL: ${POLL_INTERVAL_MS / 1000}s`);

    loadState();

    while (true) {
        for (const sym of SYMBOLS) {
            try {
                await processSymbol(sym);
            } catch (e) {
                console.error(`Error processing ${sym}:`, e);
            }
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

async function processSymbol(sym: string) {
    const state = activeState.symbols[sym];

    if (!state) {
        // INITIATE NEW CYCLE
        const P0 = await getTickerPrice(sym);
        const details = await getInstrumentDetails(sym);
        if (!P0 || !details) return;

        const ctVal = parseFloat(details.ctVal);
        const tickSz = details.tickSz;
        const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;

        const initialDirection = Math.random() > 0.5 ? 'long' : 'short';
        const sz1 = calculateContracts(MARGIN, P0, ctVal, LEVERAGE);

        const requiredMargin = (sz1 * ctVal * P0) / LEVERAGE;
        const balRes = await okxRequest('GET', '/api/v5/account/balance');
        const availBal = parseFloat(balRes?.data?.[0]?.details?.find((d: any) => d.ccy === 'USDT')?.availBal || '0');

        if (availBal < requiredMargin * 1.05) {
            console.log(`❌ [${sym}] Insufficient liquidity to start cycle. Need $${requiredMargin.toFixed(2)} USDT.`);
            return;
        }

        const D_tp_price = P0 * TP_PCT;
        const D_zone_price = P0 * ZONE_PCT;
        const E_profit = D_tp_price * sz1 * ctVal;

        const P_up_line = initialDirection === 'long' ? P0 + D_tp_price : P0 + D_zone_price;
        const P_down_line = initialDirection === 'long' ? P0 - D_zone_price : P0 - D_tp_price;

        const targetPx = Number((initialDirection === 'long' ? P_up_line : P_down_line).toFixed(tickDecimals));
        const reversePx = Number((initialDirection === 'long' ? P_down_line : P_up_line).toFixed(tickDecimals));

        console.log(`\n🎲 [${sym}] Starting Cycle. Random Pick: ${initialDirection.toUpperCase()}`);
        const side = initialDirection === 'long' ? 'buy' : 'sell';
        const success = await placeMarketOrder(sym, side, sz1);
        
        if (success) {
            const oppSide = side === 'buy' ? 'sell' : 'buy';
            
            // Limit Order for TP
            const tpOrdId = await placeLimitOrder(sym, oppSide, targetPx, sz1);
            
            // Pre-calculate Conditional Reversal
            const futureLoss = sz1 * (initialDirection === 'long' ? P0 - reversePx : reversePx - P0) * ctVal;
            const requiredProfit = E_profit + futureLoss;
            const nextTargetPx = initialDirection === 'long' ? reversePx - D_tp_price : reversePx + D_tp_price;
            const nextDistance = Math.abs(reversePx - nextTargetPx);
            
            const nextNetSz = Math.ceil(requiredProfit / (nextDistance * ctVal));
            const condSz = sz1 + nextNetSz; // Close current, open new

            // Conditional Order for Reversal
            const revAlgoId = await placeTriggerOrder(sym, oppSide, reversePx, condSz);

            if (tpOrdId && revAlgoId) {
                activeState.symbols[sym] = {
                    ctVal, P0, E_profit, D_tp_price, D_zone_price, P_up_line, P_down_line,
                    currentSide: initialDirection,
                    currentEntryPx: P0,
                    currentTargetPx: targetPx,
                    currentReversePx: reversePx,
                    currentNetSz: sz1,
                    totalRealizedLoss: 0,
                    reversalsCount: 0,
                    tpOrdId, revAlgoId
                };
                saveState();
                console.log(`✅ [${sym}] TP Limit placed at ${targetPx}, Reverse Trigger at ${reversePx} for next net size ${nextNetSz}.`);
                logEvent({ sym, action: 'cycle_start', details: { side: initialDirection, entryPx: P0, sz: sz1, targetPx, reversePx } });
            } else {
                console.error(`❌ [${sym}] Failed to place initial tracking orders. Panic closing manual position.`);
                await closeAllNet(sym);
            }
        }
    } else {
        // MONITOR ACTIVE CYCLE
        const tpStatus = await checkOrderStatus(sym, state.tpOrdId);
        
        if (tpStatus === 'filled') {
            console.log(`\n🎉 [${sym}] TAKE PROFIT HIT! Cycle cleared with total E_profit +$${state.E_profit.toFixed(2)} USDT.`);
            logEvent({ sym, action: 'take_profit', details: { profit: state.E_profit, realizedLoss: state.totalRealizedLoss, finalReversals: state.reversalsCount } });
            await cancelAlgoOrder(sym, state.revAlgoId);
            delete activeState.symbols[sym];
            saveState();
            return;
        }

        const revStatus = await checkAlgoOrderStatus(sym, state.revAlgoId);
        
        if (revStatus === 'effective' || revStatus === 'canceled' || revStatus === 'failed') {
            // Triggered!
            state.reversalsCount++;
            
            if (state.reversalsCount > MAX_REVERSALS) {
                console.log(`\n💀 [${sym}] Hit MAX_REVERSALS (${MAX_REVERSALS}). Admitting defeat to protect capital.`);
                logEvent({ sym, action: 'max_reversals_exit', details: { realizedLoss: state.totalRealizedLoss, currentNetSz: state.currentNetSz } });
                await cancelOrder(sym, state.tpOrdId);
                await closeAllNet(sym);
                delete activeState.symbols[sym];
                saveState();
                return;
            }

            console.log(`\n🔄 [${sym}] REVERSAL TRIGGERED at ${state.currentReversePx}! Initiating Layer ${state.reversalsCount + 1}...`);
            await cancelOrder(sym, state.tpOrdId); // Cancel old TP limit

            const details = await getInstrumentDetails(sym);
            if (!details) return;
            const tickDecimals = details.tickSz.includes('.') ? details.tickSz.split('.')[1].length : 0;

            // Compute realized loss from the leg that just got stopped out
            const lossTick = state.currentSide === 'long' ? state.currentEntryPx - state.currentReversePx : state.currentReversePx - state.currentEntryPx;
            const realizedLoss = state.currentNetSz * lossTick * state.ctVal;
            state.totalRealizedLoss += realizedLoss;

            // Morph into the new direction
            const newSide = state.currentSide === 'long' ? 'short' : 'long';
            const newEntryPx = state.currentReversePx;

            const newTargetPx = Number((newSide === 'short' ? state.P_down_line - state.D_tp_price : state.P_up_line + state.D_tp_price).toFixed(tickDecimals));
            const newReversePx = Number((newSide === 'short' ? state.P_up_line : state.P_down_line).toFixed(tickDecimals));

            // What net size do we currently hold? We hold exactly `future_netSz` from the math above, because the conditional order filled.
            // Let's accurately calculate it:
            const requiredProfit = state.E_profit + state.totalRealizedLoss;
            const nextDistance = Math.abs(newTargetPx - newEntryPx);
            const currentNetSz = Math.ceil(requiredProfit / (nextDistance * state.ctVal));

            // Now place NEW TP Limit
            const tpOpSide = newSide === 'long' ? 'sell' : 'buy';
            const tpOrdId = await placeLimitOrder(sym, tpOpSide, newTargetPx, currentNetSz);

            // Now pre-calculate the NEXT reversal conditional
            const futureLoss = currentNetSz * Math.abs(newEntryPx - newReversePx) * state.ctVal;
            const futureTotalLoss = state.totalRealizedLoss + futureLoss;
            const futureTargetPx = newSide === 'long' ? newReversePx - state.D_tp_price : newReversePx + state.D_tp_price;
            const futureDistance = Math.abs(newReversePx - futureTargetPx);
            const futureNetSz = Math.ceil((state.E_profit + futureTotalLoss) / (futureDistance * state.ctVal));

            const condSz = currentNetSz + futureNetSz;
            const revAlgoId = await placeTriggerOrder(sym, tpOpSide, newReversePx, condSz);

            if (tpOrdId && revAlgoId) {
                state.currentSide = newSide;
                state.currentEntryPx = newEntryPx;
                state.currentTargetPx = newTargetPx;
                state.currentReversePx = newReversePx;
                state.currentNetSz = currentNetSz;
                state.tpOrdId = tpOrdId;
                state.revAlgoId = revAlgoId;
                saveState();
                console.log(`✅ [${sym}] New TP Limit placed at ${newTargetPx}, Reverse Trigger at ${newReversePx}.`);
                logEvent({ sym, action: 'reversal', details: { count: state.reversalsCount, side: newSide, entryPx: newEntryPx, sz: currentNetSz, targetPx: newTargetPx, reversePx: newReversePx, legRealizedLoss: realizedLoss } });
            } else {
                console.error(`❌ [${sym}] Critical routing failure placing follow-up orders.`);
            }
        }
    }
}

// Start
runZoneManager();
