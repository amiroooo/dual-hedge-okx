import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import WebSocket from 'ws';
import * as readline from 'readline';

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
const SL_PCT = Number(process.env.ZR_SL_PCT) || 0.02; // New SL Distance
const REV_RATIO = 0.6; // Reversal at 60% (Less frequent, balanced size)
const MAX_REVERSALS = Number(process.env.ZR_MAX_REVERSALS) || 5;
const POLL_INTERVAL_MS = Number(process.env.ZR_POLL_INTERVAL_MS) || 5000;
const CLOSE_USDT_PROFIT = Number(process.env.ZR_CLOSE_USDT_PROFIT) || 1.0;
const FEE_PCT = 0.0008; // 0.08% estimated taker fee (Very Conservative)
const SLIPPAGE_PCT = 0.0010; // 0.10% slippage buffer (Aggressive)
const MATH_BUFFER = Number(process.env.ZR_MATH_BUFFER) || 1.05; // 5% extra size for safety

const BASE_URL = 'https://www.okx.com';
const STATE_FILE = '.zr-hedged-state.json';
const PERF_LOG = 'zr-hedged-performance.json';
const API_LOG = 'zr-api-debug.log';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CONFIG_FILE = 'zr-config.json';
const MISMATCH_FILE = 'mismatch_debug.log';

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

    SL_low: number;   // Fixed Low boundary (SL for Longs, TP for Shorts)
    TP_high: number;  // Fixed High boundary (TP for Longs, SL for Shorts)

    legs: Leg[];
    currentReversePx: number;
    revAlgoId: string;
    tickDecimals: number;
    lastRevTime?: number;

    // Per-pair config captured at cycle start
    leverage: number;
    margin: number;
}

interface ConfigPair {
    instId: string;
    leverage: number;
    margin: number;
}
interface ZRConfig {
    pairs: ConfigPair[];
}

let zrConfig: ZRConfig = { pairs: [] };
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            zrConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            tlog(`📖 Config loaded: ${zrConfig.pairs.length} pairs defined.`);
        } else {
            tlog(`ℹ️ No ${CONFIG_FILE} found. Using .env defaults.`);
            SYMBOLS.forEach(s => zrConfig.pairs.push({ instId: s, leverage: LEVERAGE, margin: MARGIN }));
        }
    } catch (e) {
        terror(`❌ Error loading config:`, e);
        SYMBOLS.forEach(s => zrConfig.pairs.push({ instId: s, leverage: LEVERAGE, margin: MARGIN }));
    }
}

interface ManagerState {
    symbols: Record<string, ZRState>;
    mismatches: Record<string, number>; // symbol -> consecutive mismatch count
}

let activeState: ManagerState = { symbols: {}, mismatches: {} };
const priceCache: Record<string, number> = {};
interface PosInfo { sz: number; upl: number; lastUpdate: number; }
const positionCache: Record<string, { long: PosInfo, short: PosInfo }> = {};
const cooldowns: Record<string, number> = {};
let pubWs: WebSocket | null = null;
let privWs: WebSocket | null = null;
let isPubReconnecting = false;
let isPrivReconnecting = false;

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

    // Telegram Notification
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        let msg = `<b>[ZR-Hedged]</b>\n`;
        msg += `💎 <b>Symbol</b>: ${event.sym}\n`;
        msg += `🎬 <b>Action</b>: ${event.action.toUpperCase()}\n`;
        if (event.details) {
            for (const [k, v] of Object.entries(event.details)) {
                let val = v;
                if (typeof v === 'number') val = v.toFixed(6);
                msg += `🔹 <b>${k}</b>: ${val}\n`;
            }
        }
        msg += `⏰ <b>Time</b>: ${new Date().toLocaleTimeString()}`;
        sendTelegramMessage(msg);
    }
}

async function sendTelegramMessage(text: string) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        // Clean token: common error is adding 'bot' prefix manually in .env
        const token = TELEGRAM_TOKEN.trim();
        const apiPath = token.startsWith('bot') ? token : `bot${token}`;

        await axios.post(`https://api.telegram.org/${apiPath}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID.trim(),
            text,
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        if (e.response?.status === 404) {
            const t = TELEGRAM_TOKEN.trim();
            const masked = `${t.substring(0, 4)}...${t.substring(t.length - 4)}`;
            terror(`❌ Telegram 404: Not Found. Token (Len: ${t.length}, Char: ${masked}) is likely invalid. Check BotFather.`);
        } else {
            terror(`❌ Telegram Failed: ${e.response?.data?.description || e.message}`);
        }
    }
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
        fs.appendFileSync(API_LOG, `[REST] ${new Date().toISOString()} | ${method} ${endpoint} | Req: ${bodyStr} | Res: ${JSON.stringify(response.data)}\n`);
        return response.data;
    } catch (error: any) {
        fs.appendFileSync(API_LOG, `[REST ERR] ${new Date().toISOString()} | ${method} ${endpoint} | Req: ${bodyStr} | Err: ${error.message}\n`);
        if (error.code === 'ECONNABORTED') return { code: '-1', msg: 'Request timed out after 10s' };
        return { code: '-1', msg: error.response?.data?.msg || error.message };
    }
}

async function getTickerPrice(instId: string): Promise<number> {
    // 1. Check WebSocket Cache first
    if (priceCache[instId]) return priceCache[instId];

    // 2. Fallback to REST if cache is empty
    for (let i = 0; i < 3; i++) {
        const res = await okxRequest('GET', `/api/v5/market/ticker?instId=${instId}`);
        if (res && res.code === '0' && res.data?.length > 0) {
            const last = parseFloat(res.data[0].last);
            priceCache[instId] = last; // Backfill cache
            return last;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return 0;
}

function initWebsocket(symbols: string[]) {
    // 1. PUBLIC WS (Tickers)
    if (!isPubReconnecting) {
        const pubUrl = IS_SIMULATED ? 'wss://wspap.okx.com:8443/ws/v5/public' : 'wss://ws.okx.com:8443/ws/v5/public';
        tlog(`🔌 Initializing Public WebSocket...`);
        isPubReconnecting = true;

        if (pubWs) { pubWs.removeAllListeners(); pubWs.terminate(); }
        pubWs = new WebSocket(pubUrl);

        let connectTimeout = setTimeout(() => {
            if (isPubReconnecting) {
                tlog("⌛ Public WS Connection timed out. Retrying...");
                pubWs?.terminate();
                isPubReconnecting = false;
                initWebsocket(symbols);
            }
        }, 15000);

        pubWs.on('open', () => {
            tlog('✅ Public WS Connected.');
            clearTimeout(connectTimeout);
            isPubReconnecting = false;
            const args = symbols.map(s => ({ channel: 'tickers', instId: s }));
            pubWs?.send(JSON.stringify({ op: 'subscribe', args }));
        });
        pubWs.on('message', (data) => {
            try {
                const dataStr = data.toString();
                if (dataStr !== 'pong') {
                    fs.appendFileSync(API_LOG, `[WS PUB] ${new Date().toISOString()} | ${dataStr}\n`);
                }
                const json = JSON.parse(dataStr);
                if (json.arg?.channel === 'tickers' && json.data?.[0]?.last) {
                    priceCache[json.arg.instId] = parseFloat(json.data[0].last);
                }
            } catch (e) { }
        });
        pubWs.on('error', (err) => terror('❌ Public WS Error:', err.message));
        pubWs.on('close', () => {
            clearTimeout(connectTimeout);
            tlog('⚠️ Public WS Closed. Reconnecting in 10s...');
            setTimeout(() => { isPubReconnecting = false; initWebsocket(symbols); }, 10000);
        });
    }

    // 2. PRIVATE WS (Positions)
    if (!isPrivReconnecting) {
        const privUrl = IS_SIMULATED ? 'wss://wspap.okx.com:8443/ws/v5/private' : 'wss://ws.okx.com:8443/ws/v5/private';
        tlog(`🔑 Initializing Private WebSocket...`);
        isPrivReconnecting = true;

        if (privWs) { privWs.removeAllListeners(); privWs.terminate(); }
        privWs = new WebSocket(privUrl);

        let connectTimeout = setTimeout(() => {
            if (isPrivReconnecting) {
                tlog("⌛ Private WS Connection timed out. Retrying...");
                privWs?.terminate();
                isPrivReconnecting = false;
                initWebsocket(symbols);
            }
        }, 15000);

        privWs.on('open', () => {
            tlog('✅ Private WS Connected. Logging in...');
            clearTimeout(connectTimeout);
            isPrivReconnecting = false;

            const timestamp = (Math.floor(Date.now() / 1000)).toString();
            const method = 'GET';
            const endpoint = '/users/self/verify';
            const prehash = timestamp + method + endpoint;
            const signature = crypto.createHmac('sha256', API_SECRET).update(prehash).digest('base64');

            privWs?.send(JSON.stringify({
                op: 'login',
                args: [{ apiKey: API_KEY, passphrase: API_PASSPHRASE, timestamp, sign: signature }]
            }));
        });
        privWs.on('message', (data) => {
            try {
                const dataStr = data.toString();
                if (dataStr === 'pong') {
                    for (const s in positionCache) {
                        positionCache[s].long.lastUpdate = Date.now();
                        positionCache[s].short.lastUpdate = Date.now();
                    }
                    return;
                }
                fs.appendFileSync(API_LOG, `[WS PRIV] ${new Date().toISOString()} | ${dataStr}\n`);
                const json = JSON.parse(dataStr);
                if (json.event === 'login' && json.code === '0') {
                    tlog('✅ Private WS Logged in. Subscribing to positions...');
                    privWs?.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'positions', instType: 'SWAP' }] }));
                } else if (json.event === 'error') {
                    terror(`❌ Private WS Event Error: ${json.msg} (Code: ${json.code})`);
                }
                if (json.arg?.channel === 'positions' && json.data) {
                    for (const pos of json.data) {
                        const sym = pos.instId;
                        if (!positionCache[sym]) {
                            positionCache[sym] = {
                                long: { sz: 0, upl: 0, lastUpdate: 0 },
                                short: { sz: 0, upl: 0, lastUpdate: 0 }
                            };
                        }
                        const side = pos.posSide;
                        if (side === 'long' || side === 'short') {
                            const s = side as 'long' | 'short';
                            positionCache[sym][s] = {
                                sz: Math.abs(parseInt(pos.pos)),
                                upl: parseFloat(pos.upl || '0'),
                                lastUpdate: Date.now()
                            };
                        }
                    }
                }
            } catch (e) { }
        });
        privWs.on('error', (err) => terror('❌ Private WS Error:', err.message));
        privWs.on('close', () => {
            clearTimeout(connectTimeout);
            tlog('⚠️ Private WS Closed. Reconnecting in 10s...');
            setTimeout(() => { isPrivReconnecting = false; initWebsocket(symbols); }, 10000);
        });
    }
}

// Global Keepalive
setInterval(() => {
    if (pubWs?.readyState === WebSocket.OPEN) pubWs.send('ping');
    if (privWs?.readyState === WebSocket.OPEN) privWs.send('ping');
}, 20000);

function initializePositionCache(symbols: string[]) {
    for (const sym of symbols) {
        if (!positionCache[sym]) {
            positionCache[sym] = {
                long: { sz: 0, upl: 0, lastUpdate: Date.now() },
                short: { sz: 0, upl: 0, lastUpdate: Date.now() }
            };
        }
    }
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
    const sides: ('long' | 'short')[] = ['long', 'short'];
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

async function placeTriggerOrder(instId: string, side: 'buy' | 'sell', posSide: 'long' | 'short', triggerPx: number, sz: number): Promise<string | null> {
    tlog(`🚀 [${instId}] Placing Trigger Order (Limit): ${side.toUpperCase()} ${sz} at ${triggerPx} (posSide: ${posSide})`);
    const res = await okxRequest('POST', '/api/v5/trade/order-algo', {
        instId, tdMode: 'isolated', side, posSide, ordType: 'trigger', triggerPx: triggerPx.toString(), orderPx: triggerPx.toString(), sz: sz.toString()
    });
    if (res && res.code === '0' && res.data?.[0]?.algoId) return res.data[0].algoId;
    terror(`❌ [${instId}] Trigger Order failed:`, res.msg || res.data?.[0]?.sMsg);
    return null;
}

async function cancelAlgoOrder(instId: string, algoId: string) {
    if (!algoId || algoId === 'manual') return;
    await okxRequest('POST', '/api/v5/trade/cancel-algos', [{ instId, algoId }]);
}

async function performGlobalCleanup() {
    tlog(`🧼 [GLOBAL] Performing account-wide DEEP order cleanup...`);

    // 1. Regular Orders
    const regRes = await okxRequest('GET', `/api/v5/trade/orders-pending`);
    if (regRes && regRes.code === '0' && regRes.data?.length > 0) {
        tlog(`🧹 [GLOBAL] Found ${regRes.data.length} regular orders. Canceling...`);
        const orders = regRes.data.map((o: any) => ({ instId: o.instId, ordId: o.ordId }));
        await okxRequest('POST', '/api/v5/trade/cancel-batch-orders', orders);
    }

    // 2. Algo / Trigger / TPSL Orders
    const types = ['trigger', 'tpsl', 'stop', 'trailing_stop', 'move_order_stop', 'iceberg', 'twap', 'conditional', 'oco', 'price_order'];
    for (const type of types) {
        // Broad query: all states, high limit
        const res = await okxRequest('GET', `/api/v5/trade/orders-algo-pending?ordType=${type}&limit=100`);
        if (res && res.code === '0' && res.data?.length > 0) {
            tlog(`🧹 [GLOBAL] Found ${res.data.length} ${type} orders. IDs: ${res.data.map((a: any) => a.algoId).join(', ')}`);
            for (const a of res.data) {
                await okxRequest('POST', '/api/v5/trade/cancel-algos', [{
                    instId: a.instId,
                    algoId: a.algoId,
                    ordType: a.algoOrdType
                }]);
            }
        }
    }

    // 3. Grid Bots (Account-wide)
    const gridRes = await okxRequest('GET', '/api/v5/tradingBot/grid/orders-algo-pending');
    if (gridRes && gridRes.code === '0' && gridRes.data?.length > 0) {
        tlog(`🤖 [GLOBAL] Found ${gridRes.data.length} active Grid Bots. Stopping all...`);
        for (const bot of gridRes.data) {
            tlog(`🛑 Stopping Grid Bot ${bot.algoId} for ${bot.instId}...`);
            await okxRequest('POST', '/api/v5/tradingBot/grid/stop-order-algo', {
                algoId: bot.algoId, instId: bot.instId, algoOrdType: bot.algoOrdType, stopType: '1' // '1' means sell all assets
            });
        }
    }

    tlog('✅ [GLOBAL] Deep cleanup finished.');
    await new Promise(r => setTimeout(r, 1000));
}

async function cancelAllAlgoOrders(instId: string) {
    tlog(`🧹 [${instId}] Checking for all pending orders (Normal & Algo)...`);
    const regRes = await okxRequest('GET', `/api/v5/trade/orders-pending?instId=${instId}`);
    if (regRes && regRes.code === '0' && regRes.data?.length > 0) {
        const orders = regRes.data.map((o: any) => ({ instId: o.instId, ordId: o.ordId }));
        await okxRequest('POST', '/api/v5/trade/cancel-batch-orders', orders);
    }
    const types = ['trigger', 'tpsl', 'stop', 'trailing_stop', 'move_order_stop', 'iceberg', 'twap', 'conditional'];
    for (const type of types) {
        const res = await okxRequest('GET', `/api/v5/trade/orders-algo-pending?instId=${instId}&algoOrdType=${type}`);
        if (res && res.code === '0' && res.data?.length > 0) {
            const algos = res.data.map((a: any) => ({ instId: a.instId, algoId: a.algoId }));
            await okxRequest('POST', '/api/v5/trade/cancel-algos', algos);
        }
    }
    const gridTypes = ['grid', 'contract_grid'];
    for (const gType of gridTypes) {
        const grid = await okxRequest('GET', `/api/v5/grid/orders-algo-pending?instId=${instId}&algoOrdType=${gType}`);
        if (grid && grid.code === '0' && grid.data?.length > 0) {
            terror(`⚠️ [${instId}] ACTIVE ${gType.toUpperCase()} DETECTED!`);
        }
    }
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

async function verifyBundleConsistencyExtended(sym: string, state: ZRState): Promise<{ consistent: boolean, liveUpl: number, liveLong: number, liveShort: number }> {
    // Grace period check: Skip consistency if we just reversed recently (allow 30s for OKX to sync)
    if (state.lastRevTime && (Date.now() - state.lastRevTime < 30000)) {
        // Return dummy consistent but try to get current UPL from cache for monitor loop
        const upl = positionCache[sym] ? (positionCache[sym].long.upl + positionCache[sym].short.upl) : 0;
        const l = positionCache[sym]?.long.sz || 0;
        const s = positionCache[sym]?.short.sz || 0;
        return { consistent: true, liveUpl: upl, liveLong: l, liveShort: s };
    }

    let liveLong = 0;
    let liveShort = 0;
    let liveUpl = 0;

    const cacheEntry = positionCache[sym];
    const stalenessLimit = 30000; // 30s
    const now = Date.now();

    const longStale = !cacheEntry || (now - cacheEntry.long.lastUpdate > stalenessLimit);
    const shortStale = !cacheEntry || (now - cacheEntry.short.lastUpdate > stalenessLimit);

    if (cacheEntry && !longStale && !shortStale) {
        liveLong = cacheEntry.long.sz;
        liveShort = cacheEntry.short.sz;
        liveUpl = cacheEntry.long.upl + cacheEntry.short.upl;
    } else {
        if (cacheEntry) tlog(`📡 [${sym}] WebSocket stale (Long: ${now - cacheEntry.long.lastUpdate}ms). Falling back to REST for sync.`);
        const res = await okxRequest('GET', `/api/v5/account/positions?instId=${sym}`);
        if (!res || res.code !== '0') return { consistent: true, liveUpl: 0, liveLong: 0, liveShort: 0 };
        for (const pos of res.data) {
            if (pos.mgnMode !== 'isolated') continue;
            const sideUpl = parseFloat(pos.upl || '0');
            liveUpl += sideUpl;
            if (pos.posSide === 'long') liveLong += Math.abs(parseInt(pos.pos));
            if (pos.posSide === 'short') liveShort += Math.abs(parseInt(pos.pos));
        }
    }

    let expectedLong = 0;
    let expectedShort = 0;
    for (const leg of state.legs) {
        if (leg.side === 'long') expectedLong += leg.sz;
        else expectedShort += leg.sz;
    }

    if (liveLong !== expectedLong || liveShort !== expectedShort) {
        // Double-check with REST API immediately to prevent WebSocket race condition bugs
        const res = await okxRequest('GET', `/api/v5/account/positions?instId=${sym}`);
        if (res && res.code === '0') {
            liveUpl = 0; liveLong = 0; liveShort = 0;
            for (const pos of res.data) {
                if (pos.mgnMode !== 'isolated') continue;
                const sideUpl = parseFloat(pos.upl || '0');
                liveUpl += sideUpl;
                if (pos.posSide === 'long') liveLong += Math.abs(parseInt(pos.pos));
                if (pos.posSide === 'short') liveShort += Math.abs(parseInt(pos.pos));
            }
            if (positionCache[sym]) {
                positionCache[sym].long.sz = liveLong;
                positionCache[sym].short.sz = liveShort;
                positionCache[sym].long.lastUpdate = Date.now();
                positionCache[sym].short.lastUpdate = Date.now();
            }
        }
    }

    if (liveLong !== expectedLong || liveShort !== expectedShort) {
        return { consistent: false, liveUpl, liveLong, liveShort };
    }
    return { consistent: true, liveUpl, liveLong, liveShort };
}

// ==========================================
// 4. CORE HEDGED LOGIC
// ==========================================

async function runHedgedManager() {
    tlog(`\n🛡️ HEDGED ZONE RECOVERY MANAGER (v2.7)`);
    tlog(`🛠️ Mode: ${IS_SIMULATED ? 'DEMO' : 'LIVE'}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = await new Promise<string>(resolve => {
        rl.question('\n👉 [1] Continue from state\n👉 [2] FULL RESET (Close all positions/orders & Wipe files)\nSelection: ', resolve);
    });
    rl.close();

    await setAccountMode();
    loadConfig();

    if (choice === '2') {
        tlog('🧨 PERFORMING FULL SYSTEM RESET...');

        // Account-wide order cleanup
        await performGlobalCleanup();

        for (const pair of zrConfig.pairs) {
            await closeAllPositions(pair.instId);
        }
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        if (fs.existsSync(PERF_LOG)) fs.unlinkSync(PERF_LOG);
        if (fs.existsSync(API_LOG)) fs.unlinkSync(API_LOG);
        if (fs.existsSync(MISMATCH_FILE)) fs.unlinkSync(MISMATCH_FILE);
        tlog('✅ Reset complete. Starting fresh.');
    }

    loadState();
    const ACTIVE_SYMBOLS = zrConfig.pairs.map(p => p.instId);
    if (ACTIVE_SYMBOLS.length === 0) {
        tlog("❌ CRITICAL: No symbols found in zr-config.json (and none in .env).");
        return;
    }

    tlog(`📈 ACTIVE SYMBOLS: ${ACTIVE_SYMBOLS.join(', ')}`);

    // START REAL-TIME POSITION CACHE
    initializePositionCache(ACTIVE_SYMBOLS);

    // START REAL-TIME PRICE FEED
    initWebsocket(ACTIVE_SYMBOLS);

    while (true) {
        // Parallel processing of symbols for better reactivity
        await Promise.all(zrConfig.pairs.map(async (pair) => {
            try { await processSymbolHedged(pair.instId); }
            catch (e) { terror(`Error on ${pair.instId}:`, e); }
        }));
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

        // Cooldown check to prevent rapid death loops
        if (cooldowns[sym] && Date.now() < cooldowns[sym]) {
            return;
        }

        const pairCfg = zrConfig.pairs.find(p => p.instId === sym) || { instId: sym, leverage: LEVERAGE, margin: MARGIN };
        const useLever = pairCfg.leverage;
        const useMargin = pairCfg.margin;

        // 0. Clean the slate first
        await cancelAllAlgoOrders(sym);

        // 1. Set Leverage and capture ACTUAL leverage used
        const actualLever = await setLeverage(sym, useLever);

        const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;
        tlog(`ℹ️ [${sym}] ctVal: ${ctVal}, Price: ${P}, Decimals: ${tickDecimals}, Leverage: ${actualLever}x, Margin: $${useMargin}`);

        const side = Math.random() > 0.5 ? 'long' : 'short';
        const sz1 = Math.max(1, Math.floor((useMargin * actualLever) / (P * ctVal)));

        const SL_low = side === 'long' ? round(P * (1 - SL_PCT), tickDecimals) : round(P * (1 - TP_PCT), tickDecimals);
        const TP_high = side === 'long' ? round(P * (1 + TP_PCT), tickDecimals) : round(P * (1 + SL_PCT), tickDecimals);

        // Standardize boundaries: SL_low is always the "bottom" exit, TP_high is always the "top" exit.
        // For Longs: TP=TP_high, SL=SL_low. For Shorts: TP=SL_low, SL=TP_high.
        const tpPx = side === 'long' ? TP_high : SL_low;
        const slPx = side === 'long' ? SL_low : TP_high;

        const success = await executeOrder(sym, side === 'long' ? 'buy' : 'sell', side, sz1, tpPx, slPx);
        if (success) {
            const nextSide = side === 'long' ? 'short' : 'long';
            const reversePx = side === 'long'
                ? round(P - (P * SL_PCT * REV_RATIO), tickDecimals)
                : round(P + (P * SL_PCT * REV_RATIO), tickDecimals);

            const nextTargetPx = nextSide === 'long' ? TP_high : SL_low;

            // PnL of Leg 1 at Leg 2's target
            const pnl1AtTarget = (side === 'long' ? (nextTargetPx - P) : (P - nextTargetPx)) * sz1 * ctVal;
            const prevLegsFees = (sz1 * ctVal * P * FEE_PCT) * 2;
            const targetUSDT = CLOSE_USDT_PROFIT + prevLegsFees; // Break-even + safety on reversal
            const netNeeded = targetUSDT - pnl1AtTarget;

            const effectiveDist = (Math.abs(nextTargetPx - reversePx) * (1 - SLIPPAGE_PCT)) * ctVal;
            const feeCostPerContract = (reversePx * FEE_PCT) * 2 * ctVal;
            const sz2 = Math.ceil((netNeeded / (effectiveDist - feeCostPerContract)) * MATH_BUFFER);

            const revAlgoId = await placeTriggerOrder(sym, nextSide === 'long' ? 'buy' : 'sell', nextSide, reversePx, sz2);

            activeState.symbols[sym] = {
                ctVal, P0: P, E_profit: Math.abs(tpPx - P) * sz1 * ctVal,
                SL_low, TP_high,
                legs: [{ side, entryPx: P, sz: sz1 }],
                currentReversePx: reversePx,
                revAlgoId: revAlgoId || 'manual',
                tickDecimals,
                leverage: useLever,
                margin: useMargin
            };
            saveState();
            logEvent({ sym, action: 'start', details: { side, entryPx: P, sz: sz1, tpPx, slPx, revAlgoId } });
        }
    } else {
        // 1. FETCH LIVE STATE FIRST
        const { consistent, liveUpl, liveLong, liveShort } = await verifyBundleConsistencyExtended(sym, state);

        // 2. SELF-HEALING REVERSAL CHECK
        const lastLeg = state.legs[state.legs.length - 1];
        const currentSide = lastLeg.side;
        const nextSide = currentSide === 'long' ? 'short' : 'long';

        // MATH FOR BOUND STRATEGY (Calculate Sz_new required for reversal):
        const tickDecimals = state.tickDecimals;
        const nextTargetPx = nextSide === 'long' ? state.TP_high : state.SL_low;
        const nextStopPx = nextSide === 'long' ? state.SL_low : state.TP_high;

        let pnlAtTarget = 0;
        for (const leg of state.legs) {
            if (leg.side === 'long') pnlAtTarget += (nextTargetPx - leg.entryPx) * leg.sz * state.ctVal;
            else pnlAtTarget += (leg.entryPx - nextTargetPx) * leg.sz * state.ctVal;
        }

        let estFeesPrev = 0;
        for (const leg of state.legs) {
            estFeesPrev += (leg.sz * state.ctVal * leg.entryPx * FEE_PCT) * 2;
        }
        const targetUSDT = CLOSE_USDT_PROFIT + estFeesPrev; // Break-even + safety
        const netNeeded = targetUSDT - pnlAtTarget;

        const effectiveDist = (Math.abs(nextTargetPx - state.currentReversePx) * (1 - SLIPPAGE_PCT)) * state.ctVal;
        const feeCostPerContract = (state.currentReversePx * FEE_PCT) * 2 * state.ctVal;
        const sz = Math.ceil((netNeeded / (effectiveDist - feeCostPerContract)) * MATH_BUFFER);

        // Await full execution of limit order before proceeding to prevent partial fill vulnerability
        const currentSumNextSide = state.legs.filter(l => l.side === nextSide).reduce((acc, l) => acc + l.sz, 0);
        const nextSideLive = nextSide === 'long' ? liveLong : liveShort;
        const fullyReversed = nextSideLive >= (currentSumNextSide + sz);

        if (fullyReversed) {
            if (state.legs.length >= MAX_REVERSALS) {
                tlog(`⚠️ [${sym}] Max Reversals (${MAX_REVERSALS}) reached. No more hedging. Waiting for SL/TP.`);
                return;
            }
            tlog(`\n🔄 [${sym}] REVERSAL FULLY OPENED! (Exchange Synced)...`);
            tlog(`🧪 [${sym}] Leg ${state.legs.length + 1} Sizing: NetNeeded:$${netNeeded.toFixed(2)}, Sz:${sz}`);

            // Update state with the new leg
            state.legs.push({ side: nextSide, entryPx: state.currentReversePx, sz });

            // 1. Re-attach hard TP/SL for the NEW position side
            // We use 'conditional' ordType. To close a leg, we must place an order in the opposite direction.
            // If new leg is LONG, TP is Sell at TP_high, SL is Sell at SL_low.
            const closingSide = nextSide === 'long' ? 'sell' : 'buy';
            tlog(`🛡️ [${sym}] Attaching Hard TP/SL to ${nextSide.toUpperCase()} leg (Sz: ${sz})...`);
            await okxRequest('POST', '/api/v5/trade/order-algo', {
                instId: sym, tdMode: 'isolated', posSide: nextSide, side: closingSide,
                ordType: 'conditional', sz: sz.toString(),
                tpTriggerPx: nextTargetPx.toString(), tpOrdPx: '-1',
                slTriggerPx: nextStopPx.toString(), slOrdPx: '-1'
            });

            // 2. Calculate and Prepare NEXT reversal (Leg N+2)
            const nextSideReversed = nextSide === 'long' ? 'short' : 'long';

            // Build the recovery corridor correctly between entry and reversal price
            const initialLeg = state.legs[0].side;
            let newReversePx = 0;
            if (initialLeg === 'long') {
                newReversePx = nextSideReversed === 'long'
                    ? state.P0
                    : round(state.P0 - (state.P0 * SL_PCT * REV_RATIO), state.tickDecimals);
            } else {
                newReversePx = nextSideReversed === 'short'
                    ? state.P0
                    : round(state.P0 + (state.P0 * SL_PCT * REV_RATIO), state.tickDecimals);
            }

            // CALCULATE SIZE FOR NEXT LEG (so user sees it on exchange)
            // Re-run the sizing logic but for the next leg count
            let pnlAtNextTarget = 0;
            const nextLegs = [...state.legs]; // Copy current legs (after we added the new one)
            const nextTargetPxN2 = nextSideReversed === 'long' ? state.TP_high : state.SL_low;
            for (const leg of nextLegs) {
                if (leg.side === 'long') pnlAtNextTarget += (nextTargetPxN2 - leg.entryPx) * leg.sz * state.ctVal;
                else pnlAtNextTarget += (leg.entryPx - nextTargetPxN2) * leg.sz * state.ctVal;
            }
            const totalSzNext = nextLegs.reduce((acc, l) => acc + l.sz, 0);
            const estFeesNext = (totalSzNext * state.ctVal * newReversePx * FEE_PCT) * 2;
            const targetUSDTNext = CLOSE_USDT_PROFIT + estFeesNext; // Break-even + safety
            const netNeededNext = targetUSDTNext - pnlAtNextTarget;
            const effectiveDistNext = (Math.abs(nextTargetPxN2 - newReversePx) * (1 - SLIPPAGE_PCT)) * state.ctVal;
            const feeCostPerContractNext = (newReversePx * FEE_PCT) * 2 * state.ctVal;
            const szNext = Math.ceil((netNeededNext / (effectiveDistNext - feeCostPerContractNext)) * MATH_BUFFER);

            tlog(`🚀 [${sym}] Preparing Log ${state.legs.length + 1} Reversal Trigger. Sz: ${szNext}`);
            const nextAlgoId = await placeTriggerOrder(sym, nextSideReversed === 'long' ? 'buy' : 'sell', nextSideReversed, newReversePx, szNext);

            state.currentReversePx = newReversePx;
            state.revAlgoId = nextAlgoId || 'manual';
            state.lastRevTime = Date.now();
            saveState();
            logEvent({ sym, action: 'reversal', details: { side: nextSide, sz, count: state.legs.length, nextAlgoId, nextSz: szNext } });
            return;
        }

        // 3. CONSISTENCY CHECK (If no reversal detected but sizes mismatch)
        if (!consistent) {
            const livePositions = await okxRequest('GET', `/api/v5/account/positions?instId=${sym}`);
            const totalContracts = livePositions.data?.reduce((acc: number, p: any) => acc + Math.abs(parseInt(p.pos)), 0) || 0;

            if (totalContracts === 0) {
                tlog(`🏁 [${sym}] No positions on exchange. Cycle finished externally.`);
                await cancelAlgoOrder(sym, state.revAlgoId);
                delete activeState.symbols[sym];
                delete activeState.mismatches[sym];
                saveState();
                logEvent({ sym, action: 'exit_external', details: { msg: 'Exchange closed positions' } });
                return;
            }

            const count = (activeState.mismatches[sym] || 0) + 1;
            activeState.mismatches[sym] = count;
            if (count < 12) {
                tlog(`⚠️ [${sym}] Consistency Mismatch! OKX:L:${liveLong} S:${liveShort} | JSON:L:${(state.legs.filter(l => l.side === 'long').reduce((a, l) => a + l.sz, 0))} S:${(state.legs.filter(l => l.side === 'short').reduce((a, l) => a + l.sz, 0))} (${count}/12)`);
                fs.appendFileSync(MISMATCH_FILE, `[${new Date().toISOString()}] [${sym}] Mismatch Info -> OKX liveLong/Short: ${liveLong}/${liveShort} | JSON: ${state.legs.filter(l => l.side === 'long').reduce((a, l) => a + l.sz, 0)}/${state.legs.filter(l => l.side === 'short').reduce((a, l) => a + l.sz, 0)}\n`);
                return;
            } else {
                tlog(`❌ [${sym}] Out of sync. FORCING CLOSE ALL. (Cooldown 60s)`);
                await cancelAllAlgoOrders(sym);
                await closeAllPositions(sym);
                delete activeState.symbols[sym];
                delete activeState.mismatches[sym];
                cooldowns[sym] = Date.now() + 60000; // 1 min cooldown
                saveState();
                logEvent({ sym, action: 'exit_mismatch', details: { msg: 'Forced close' } });
                return;
            }
        }
        if (activeState.mismatches[sym]) delete activeState.mismatches[sym];

        // 4. MONITOR PROFIT
        const totalSz = state.legs.reduce((acc, l) => acc + l.sz, 0);
        const feesPaidEst = (totalSz * state.ctVal * P * FEE_PCT) * 2;
        const bundlePnlNet = liveUpl - feesPaidEst;

        const targetRequired = state.legs.length === 1 ? (state.E_profit + CLOSE_USDT_PROFIT) : CLOSE_USDT_PROFIT;

        if (bundlePnlNet >= targetRequired) {
            tlog(`\n🎉 [${sym}] Profit Net: +$${bundlePnlNet.toFixed(2)} USDT. Closing.`);
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
