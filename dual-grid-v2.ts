import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as readline from 'readline';
import * as fs from 'fs';

dotenv.config();

const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;
const BASE_URL = 'https://www.okx.com';
const CONFIG_PATH = './v2-config.json';
const LOG_PATH = 'api_debug.log';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

    const logEntry = `\n[${timestamp}] ${method} ${endpoint}\nReq: ${bodyStr}\n`;
    fs.appendFileSync(LOG_PATH, logEntry);

    try {
        const response = await axios({ method, url: `${BASE_URL}${endpoint}`, headers, data: bodyStr ? bodyStr : undefined });
        fs.appendFileSync(LOG_PATH, `Res: ${JSON.stringify(response.data)}\n`);
        return response.data;
    } catch (error: any) {
        const errMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        fs.appendFileSync(LOG_PATH, `ERR: ${errMsg}\n`);
        return { code: '-1', msg: error.message };
    }
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function findActiveBots(symbol: string) {
    const res = await okxRequest('GET', `/api/v5/tradingBot/grid/orders-algo-pending?instId=${symbol}&algoOrdType=contract_grid`);
    if (res && res.code === '0' && res.data && res.data.length > 0) {
        const active = res.data.filter((d: any) => d.instId === symbol);
        return {
            long: active.find((d: any) => d.direction === 'long')?.algoId || null,
            short: active.find((d: any) => d.direction === 'short')?.algoId || null,
            lever: active[0]?.lever ? parseInt(active[0].lever) : null,
            baseMargin: active[0]?.sz ? parseFloat(active[0].sz) : null
        };
    }
    return { long: null, short: null, lever: null, baseMargin: null };
}

async function getAvailUSDT() {
    const res = await okxRequest('GET', '/api/v5/account/balance?ccy=USDT');
    if (res.code === '0' && res.data.length > 0) {
        return parseFloat(res.data[0].details[0].availBal || '0');
    }
    return 0;
}

function optimizeGridNum(notionalValue: number, minPx: number, maxPx: number) {
    const MIN_NET_PROFIT_USDT = 0.20;
    const FEE_FUDGE = 0.0012 * 2;
    let gridNum = 150;
    let expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
    let netProfitUsdt = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_FUDGE);
    while (gridNum > 3 && netProfitUsdt < MIN_NET_PROFIT_USDT) {
        gridNum -= 1;
        expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
        netProfitUsdt = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_FUDGE);
    }
    return { gridNum, netProfitUsdt };
}

async function setLeverageIfRequired(symbol: string, targetLev: number) {
    const res = await okxRequest('GET', `/api/v5/account/leverage-info?instId=${symbol}&mgnMode=isolated`);
    if (res.code === '0' && res.data.length > 0) {
        if (parseInt(res.data[0].lever) === targetLev) return;
    }
    await okxRequest('POST', '/api/v5/account/set-leverage', {
        instId: symbol, lever: targetLev.toString(), mgnMode: 'isolated'
    });
}

async function getBotPnl(algoId: string) {
    const res = await okxRequest('GET', `/api/v5/tradingBot/grid/orders-algo-details?algoId=${algoId}&algoOrdType=contract_grid`);
    if (res.code === '0' && res.data.length > 0) {
        const d = res.data[0];
        return {
            realized: parseFloat(d.gridProfit || '0'),
            total: parseFloat(d.totalPnl || '0')
        };
    }
    return { realized: 0, unrealized: 0, total: 0 };
}

async function stopGridBot(algoId: string, instId: string) {
    return await okxRequest('POST', '/api/v5/tradingBot/grid/stop-order-algo', [{
        algoId, instId, algoOrdType: 'contract_grid', stopType: '1'
    }]);
}

interface PairState {
    longAlgoId: string | null;
    shortAlgoId: string | null;
    baseMargin: number;
    lastCheck: number;
    lastTotalPnl?: number;
    lastTotalGridProfit?: number;
    lastTarget?: number;
}

async function sendTelegram(text: string) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const token = TELEGRAM_TOKEN.trim();
        const apiPath = token.startsWith('bot') ? token : `bot${token}`;
        await axios.post(`https://api.telegram.org/${apiPath}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID.trim(),
            text,
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        fs.appendFileSync(LOG_PATH, `Telegram ERR: ${e.message}\n`);
    }
}

async function main() {
    console.log(`\n=== DUAL-GRID V2 PORTFOLIO MANAGER ===`);
    let pairsState: Record<string, PairState> = {};

    while (true) {
        const allConfig = loadConfig();
        const enabledPairs = Object.keys(allConfig).filter(p => allConfig[p].enabled);

        if (enabledPairs.length === 0) {
            console.log(`⚠️ No enabled pairs found in config. Retrying in 30s...`);
            await new Promise(r => setTimeout(r, 30000));
            continue;
        }

        for (const symbol of enabledPairs) {
            const config = allConfig[symbol];
            let state = pairsState[symbol];

            // 1. Initialize/Inherit state
            if (!state) {
                console.log(`\n🔍 Scanning OKX for ${symbol}...`);
                const active = await findActiveBots(symbol);
                state = {
                    longAlgoId: active.long,
                    shortAlgoId: active.short,
                    baseMargin: active.baseMargin || 0,
                    lastCheck: 0
                };
                pairsState[symbol] = state;
                if (state.longAlgoId) {
                    console.log(`✅ ${symbol} Inheritance Successful: Long(${state.longAlgoId}) Short(${state.shortAlgoId})`);
                }
            }

            // 2. Deploy if missing
            if (!state.longAlgoId || !state.shortAlgoId) {
                console.log(`\n📦 Deploying Fresh Dual Grids for ${symbol} @ ${config.leverage}x...`);
                await setLeverageIfRequired(symbol, config.leverage);

                const availUsdt = await getAvailUSDT();
                const totalTargetPerBot = Math.min(config.maxMargin || 500, availUsdt / 2);
                
                state.baseMargin = totalTargetPerBot * (1 - config.extraMarginPct);
                const extraAmt = totalTargetPerBot * config.extraMarginPct;

                if (state.baseMargin < 20) {
                    console.error(`❌ ${symbol}: Insufficient Wallet Balance ($${availUsdt.toFixed(2)})`);
                    continue; // Skip this pair this loop
                }

                const ticker = await okxRequest('GET', `/api/v5/market/ticker?instId=${symbol}`);
                const p = parseFloat(ticker.data[0].last);
                const inst = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${symbol}`);
                const tickDecimals = inst.data[0].tickSz.includes('.') ? inst.data[0].tickSz.split('.')[1].length : 0;

                const maxPx = (p * (1 + config.rangePct)).toFixed(tickDecimals);
                const minPx = (p * (1 - config.rangePct)).toFixed(tickDecimals);

                const { gridNum, netProfitUsdt } = optimizeGridNum((state.baseMargin * (2 / 3)) * config.leverage, parseFloat(minPx), parseFloat(maxPx));

                const p_num = parseFloat(p.toString());
                const maxPx_num = parseFloat(maxPx);
                const minPx_num = parseFloat(minPx);
                const gridRange = maxPx_num - minPx_num;
                const bufferDistance = gridRange * 0.02;

                const create = async (dir: 'long' | 'short') => {
                    const sl = dir === 'long' ? (minPx_num - bufferDistance).toFixed(tickDecimals) : (maxPx_num + bufferDistance).toFixed(tickDecimals);
                    const tp = dir === 'long' ? (maxPx_num + bufferDistance).toFixed(tickDecimals) : (minPx_num - bufferDistance).toFixed(tickDecimals);

                    const payload = {
                        instId: symbol, algoOrdType: 'contract_grid',
                        maxPx, minPx, gridNum: gridNum.toString(), runType: '2',
                        direction: dir, lever: config.leverage.toString(), sz: state.baseMargin.toFixed(2),
                        tdMode: 'isolated',
                        slTriggerPx: sl,
                        tpTriggerPx: tp
                    };
                    const res = await okxRequest('POST', '/api/v5/tradingBot/grid/order-algo', payload);
                    if (res.code !== '0') return null;

                    const algoId = res.data[0].algoId;
                    const extraAmtVal = totalTargetPerBot * config.extraMarginPct;
                    if (extraAmtVal > 0) {
                        await new Promise(r => setTimeout(r, 2000));
                        await okxRequest('POST', '/api/v5/tradingBot/grid/margin-balance', { algoId, type: 'add', amt: extraAmtVal.toFixed(2) });
                    }
                    return algoId;
                };

                state.longAlgoId = await create('long');
                state.shortAlgoId = await create('short');
                if (state.longAlgoId) {
                    const gridRange = parseFloat(maxPx) - parseFloat(minPx);
                    const bufferDistance = gridRange * 0.02;
                    const lSL = (parseFloat(minPx) - bufferDistance).toFixed(tickDecimals);
                    const lTP = (parseFloat(maxPx) + bufferDistance).toFixed(tickDecimals);
                    const sSL = (parseFloat(maxPx) + bufferDistance).toFixed(tickDecimals);
                    const sTP = (parseFloat(minPx) - bufferDistance).toFixed(tickDecimals);

                    console.log(`✅ ${symbol} Dual-Grid Active.`);
                    await sendTelegram(`🚀 <b>Dual-Grid Deployed: ${symbol}</b>\n🔹 Leverage: ${config.leverage}x\n🔹 Total Margin: $${totalTargetPerBot.toFixed(2)}\n🔹 Range: ${config.rangePct * 100}%\n🔹 Grids: ${gridNum} ($${netProfitUsdt.toFixed(2)}/step)\n\n🛡 <b>Safety Limits:</b>\n📊 Long: SL ${lSL} | TP ${lTP}\n📊 Short: SL ${sSL} | TP ${sTP}`);
                }
            }

            // 3. Monitor PnL
            const pnlL = await getBotPnl(state.longAlgoId!);
            const pnlS = await getBotPnl(state.shortAlgoId!);

            const totalPnl = pnlL.total + pnlS.total;
            const totalGridProfit = pnlL.realized + pnlS.realized;

            const currentPairTotalMargin = state.baseMargin / (1 - config.extraMarginPct);
            const target = Math.max(30, currentPairTotalMargin * config.profitTargetPct);

            // Update state for Dashboard
            state.lastTotalPnl = totalPnl;
            state.lastTotalGridProfit = totalGridProfit;
            state.lastTarget = target;

            if (totalPnl > 0 && totalPnl >= target) {
                console.log(`\n🎯 [${symbol}] PROFIT TARGET HIT! Resetting...`);
                await stopGridBot(state.longAlgoId!, symbol);
                await stopGridBot(state.shortAlgoId!, symbol);

                // Track profit
                const updatedConfig = loadConfig();
                if (!updatedConfig[symbol]) updatedConfig[symbol] = config;
                const gainTotal = totalPnl;
                updatedConfig[symbol].totalProfit = (updatedConfig[symbol].totalProfit || 0) + gainTotal;
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));

                console.log(`💰 Total Profit for ${symbol}: $${updatedConfig[symbol].totalProfit.toFixed(2)}`);
                console.log(`⏳ [${symbol}] Settling gains. Waiting 60s...`);
                await new Promise(r => setTimeout(r, 60000));

                // Compounding
                const nextTotalMargin = Math.min(config.maxMargin, currentPairTotalMargin + (gainTotal / 2));
                state.baseMargin = nextTotalMargin * (1 - config.extraMarginPct);

                await sendTelegram(`✅ <b>PROFIT TARGET HIT: ${symbol}</b>\n💰 Cycle Net: +$${gainTotal.toFixed(2)}\n🏦 Bankroll: $${updatedConfig[symbol].totalProfit.toFixed(2)}\n♻️ Next Cycle: $${nextTotalMargin.toFixed(2)}`);

                console.log(`♻️ [${symbol}] Cycle reset. Next Total Margin per Bot: $${nextTotalMargin.toFixed(2)}`);
                state.longAlgoId = null;
                state.shortAlgoId = null;
            }

            await new Promise(r => setTimeout(r, 1000)); // Rate limit buffer
        }

        // Dashboard Refresh
        const liveStrs = enabledPairs.map(s => {
            const st = pairsState[s];
            if (!st || st.lastTotalPnl === undefined || st.lastTarget === undefined) return `${s}: ...`;
            const gridProfitSTR = `+${st.lastTotalGridProfit!.toFixed(2)}`;
            return `${s}: $${st.lastTotalPnl.toFixed(2)}(G:${gridProfitSTR})/$${st.lastTarget.toFixed(1)}`;
        });
        const totalPortProfit = enabledPairs.reduce((s, p) => s + (allConfig[p].totalProfit || 0), 0);

        const dashboard = `[Dashboard] ${liveStrs.join(' | ')} | Total Bank: $${totalPortProfit.toFixed(2)}`;
        process.stdout.write(`\r${dashboard}${' '.repeat(20)}`);

        await new Promise(r => setTimeout(r, 5000)); // Outer loop pulse
    }
}

main();
