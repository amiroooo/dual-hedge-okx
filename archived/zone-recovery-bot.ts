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

// Standalone config parameters
const SYMBOL = process.env.ZR_SYMBOL || 'BTC-USDT-SWAP';
const MARGIN = Number(process.env.ZR_MARGIN) || 10;
const LEVERAGE = Number(process.env.ZR_LEVERAGE) || 5;
const TP_PCT = Number(process.env.ZR_TP_PCT) || 0.01;
const ZONE_PCT = Number(process.env.ZR_ZONE_PCT) || 0.01;
const MAX_REVERSALS = Number(process.env.ZR_MAX_REVERSALS) || 5;
const POLL_INTERVAL_MS = Number(process.env.ZR_POLL_INTERVAL_MS) || 5000;

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.zr-state.json';

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
interface Trade {
    side: 'long' | 'short';
    entryPx: number;
    sz: number;
}
interface ZRState {
    active: boolean;
    ctVal: number;
    P0: number;
    E_profit: number;
    D_tp_price: number;
    D_zone_price: number;
    P_up_line: number;
    P_down_line: number;
    targetPx: number;
    reversePx: number;
    trades: Trade[];
}

let activeState: ZRState | null = null;

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            activeState = JSON.parse(data);
        }
    } catch (e) {
        console.error("Failed to load state", e);
        activeState = null;
    }
}

function saveState() {
    if (activeState) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(activeState, null, 2));
    } else {
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    }
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
    console.log(`\n🚀 [${instId}] Executing MARKET ${side.toUpperCase()} ${sz} contracts`);
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
    console.log(`\n♻️ [${instId}] Closing all manual positions to lock PNL / Exit.`);
    if (posMode === 'net_mode') {
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'net', mgnMode: 'isolated' });
    } else {
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'long', mgnMode: 'isolated' });
        await okxRequest('POST', '/api/v5/trade/close-position', { instId, posSide: 'short', mgnMode: 'isolated' });
    }
}

// ==========================================
// 4. CORE BOT LOGIC
// ==========================================

async function runZoneRecoveryBot() {
    console.log(`\n🤖 Starting ZONE RECOVERY BOT (Standalone) (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`📈 SYMBOL: ${SYMBOL} | MARGIN: ${MARGIN} USDT | LEVERAGE: ${LEVERAGE}x`);
    console.log(`🎯 TP_PCT: ${(TP_PCT * 100).toFixed(2)}% | 🛑 ZONE_PCT: ${(ZONE_PCT * 100).toFixed(2)}%`);
    console.log(`⏱️ POLL INTERVAL: ${POLL_INTERVAL_MS / 1000}s | 🔄 MAX REVERSALS: ${MAX_REVERSALS}`);

    loadState();

    let posMode = 'long_short_mode';
    const cfgRes = await okxRequest('GET', '/api/v5/account/config');
    if (cfgRes && cfgRes.code === '0') {
        posMode = cfgRes.data[0].posMode;
        console.log(`⚙️ POSITION MODE: ${posMode}`);
    }

    const isNetMode = posMode === 'net_mode';

    while (true) {
        try {
            await runTick(isNetMode, posMode);
        } catch (error) {
            console.error(`\n❌ Error during iteration:`, error);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

async function runTick(isNetMode: boolean, posMode: string) {
    const P = await getTickerPrice(SYMBOL);
    if (!P) return;

    if (!activeState) {
        console.log(`\n🎲 No active cycle found. Initiating a new random Zone Recovery cycle...`);
        const instDetails = await getInstrumentDetails(SYMBOL);
        if (!instDetails) return;

        const ctVal = parseFloat(instDetails.ctVal);
        
        // Randomly pick initial direction
        const initialDirection = Math.random() > 0.5 ? 'long' : 'short';
        const sz = calculateContracts(MARGIN, P, ctVal, LEVERAGE);

        // Calculate absolute price distances
        const D_tp_price = P * TP_PCT;
        const D_zone_price = P * ZONE_PCT;

        // Calculate physical Zone Boundaries
        const P_up_line = initialDirection === 'long' ? P + D_tp_price : P + D_zone_price;
        const P_down_line = initialDirection === 'long' ? P - D_zone_price : P - D_tp_price;

        const targetPx = initialDirection === 'long' ? P + D_tp_price : P - D_tp_price;
        const reversePx = initialDirection === 'long' ? P - D_zone_price : P + D_zone_price;

        // Expected profit
        const E_profit = D_tp_price * sz * ctVal;

        const side = initialDirection === 'long' ? 'buy' : 'sell';
        const posSide = isNetMode ? 'net' : initialDirection;

        // Liquidity check
        const requiredMargin = (sz * ctVal * P) / LEVERAGE;
        const balRes = await okxRequest('GET', '/api/v5/account/balance');
        const usdtDetails = balRes?.data?.[0]?.details?.find((d: any) => d.ccy === 'USDT');
        const availBal = usdtDetails ? parseFloat(usdtDetails.availBal || '0') : 0;

        if (availBal < requiredMargin * 1.05) {
            console.log(`\n❌ Insufficient liquidity for start! Need ~$${requiredMargin.toFixed(2)} USDT, but wallet only has $${availBal.toFixed(2)} USDT.`);
            return;
        }

        const success = await executeMarketOrder(SYMBOL, side, posSide, sz);
        if (success) {
            activeState = {
                active: true,
                ctVal,
                P0: P,
                E_profit,
                D_tp_price,
                D_zone_price,
                P_up_line,
                P_down_line,
                targetPx,
                reversePx,
                trades: [{ side: initialDirection, entryPx: P, sz }]
            };
            saveState();
        }
    } else {
        // ACTIVE CYCLE LOGIC
        // 1. Check if we hit TARGET or profit threshold
        let bundlePnl = 0;
        for (const t of activeState.trades) {
            if (t.side === 'long') bundlePnl += (P - t.entryPx) * t.sz * activeState.ctVal;
            else bundlePnl += (t.entryPx - P) * t.sz * activeState.ctVal;
        }

        const lastTrade = activeState.trades[activeState.trades.length - 1];
        const isLong = lastTrade.side === 'long';

        const hitTarget = (isLong && P >= activeState.targetPx) || (!isLong && P <= activeState.targetPx);
        
        if (hitTarget || bundlePnl >= activeState.E_profit) {
            console.log(`\n🎉 [${SYMBOL}] Target Hit! Bundle PNL: +${bundlePnl.toFixed(2)} USDT (Target: ${activeState.E_profit.toFixed(2)}). Nulling cycle!`);
            await closeAllManual(SYMBOL, posMode);
            activeState = null;
            saveState();
            return;
        }

        // 2. Check if we hit REVERSAL LINE
        const hitReverse = (isLong && P <= activeState.reversePx) || (!isLong && P >= activeState.reversePx);

        if (hitReverse) {
            if (activeState.trades.length >= MAX_REVERSALS) {
                console.log(`\n💀 [${SYMBOL}] Hit MAX_REVERSALS (${MAX_REVERSALS}). Closing at a loss to protect account.`);
                await closeAllManual(SYMBOL, posMode);
                activeState = null;
                saveState();
                return;
            }

            console.log(`\n🔄 [${SYMBOL}] Price hit Reversal Line (${activeState.reversePx}). Bundle PNL: ${bundlePnl.toFixed(2)}. Initiating Reverse Layer!`);
            
            const newSide = isLong ? 'short' : 'long';
            
            // New Target and Reverse lines map directly to the Zone Physical Bounds
            let newTargetPx, newReversePx;
            if (newSide === 'short') { // We hit the bottom line
                newTargetPx = activeState.P_down_line - activeState.D_tp_price;
                newReversePx = activeState.P_up_line;
            } else { // We hit the top line
                newTargetPx = activeState.P_up_line + activeState.D_tp_price;
                newReversePx = activeState.P_down_line;
            }

            // Calculate new required size
            let existingPnlAtTarget = 0;
            for (const t of activeState.trades) {
                if (t.side === 'long') existingPnlAtTarget += (newTargetPx - t.entryPx) * t.sz * activeState.ctVal;
                else existingPnlAtTarget += (t.entryPx - newTargetPx) * t.sz * activeState.ctVal;
            }

            const requiredNewPnl = activeState.E_profit - existingPnlAtTarget;
            const unitPnl = newSide === 'long' ? (newTargetPx - P) : (P - newTargetPx);

            let sz = 1;
            if (unitPnl > 0) {
                sz = Math.ceil(requiredNewPnl / (unitPnl * activeState.ctVal));
                if (sz < 1) sz = 1;
            }

            const sideOp = newSide === 'long' ? 'buy' : 'sell';
            const posSide = isNetMode ? 'net' : newSide;

            // Liquidity Check
            const requiredMargin = (sz * activeState.ctVal * P) / LEVERAGE;
            const balRes = await okxRequest('GET', '/api/v5/account/balance');
            const usdtDetails = balRes?.data?.[0]?.details?.find((d: any) => d.ccy === 'USDT');
            const availBal = usdtDetails ? parseFloat(usdtDetails.availBal || '0') : 0;

            if (availBal < requiredMargin * 1.05) {
                console.log(`\n❌ Insufficient liquidity for reversal! Need ~$${requiredMargin.toFixed(2)} USDT, but wallet only has $${availBal.toFixed(2)} USDT. Skipping...`);
                return;
            }

            const success = await executeMarketOrder(SYMBOL, sideOp, posSide, sz);
            if (success) {
                activeState.reversePx = newReversePx;
                activeState.targetPx = newTargetPx;
                activeState.trades.push({ side: newSide, entryPx: P, sz });
                saveState();
            }
        }
    }
}

// Start
runZoneRecoveryBot();
