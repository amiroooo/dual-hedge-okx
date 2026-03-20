import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as readline from 'readline';
import { scanPairs } from './find-optimal-pairs.ts';

dotenv.config();

function askQuestion(query: string, defaultValue?: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const prompt = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
    return new Promise((resolve) => rl.question(prompt, (ans) => {
        rl.close();
        resolve(ans.trim() || defaultValue || '');
    }));
}

async function askConfirmation(query: string): Promise<boolean> {
    const ans = await askQuestion(query, 'n');
    return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
}

// ==========================================
// 1. CONFIGURATION & SETUP
// ==========================================
const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;
const bufferDistanceToClose = Number(process.env.OKX_BUFFER_DISTANCE_TO_CLOSE) || 0.02;
const gridPercentRange = Number(process.env.OKX_GRID_PERCENTAGE_RANGE) || 0.10;
const liqPercentageDistance = 0.1;

const BASE_URL = 'https://www.okx.com';

// ==========================================
// 2. OKX API CORE FUNCTIONS
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
    if (IS_SIMULATED) {
        headers['x-simulated-trading'] = '1';
    }

    try {
        const response = await axios({ method, url: `${BASE_URL}${endpoint}`, headers, data: bodyStr ? bodyStr : undefined });
        return response.data;
    } catch (error: any) {
        console.error(`\n❌ OKX API Error [${endpoint}]:`);
        console.error(error.response?.data || error.message);
        return { code: '-1', msg: error.message };
    }
}

// ==========================================
// 3. BOT LOGIC
// ==========================================

async function deployDualGrids() {
    let symbol = '';
    let leverage = 10;
    let marginUsdt = 100;
    let extraMarginUsdt = 0;
    let slippageRatio: string | null = null;

    // Parse command-line arguments if provided
    const args = process.argv.slice(2);
    if (args.length >= 3) {
        symbol = args[0];
        leverage = parseInt(args[1], 10);
        marginUsdt = parseFloat(args[2]);
        extraMarginUsdt = args[3] ? parseFloat(args[3]) : 0;
        slippageRatio = args[4] ? args[4] : null;
    } else {
        // Interactive Mode
        console.log(`\n🚀 Entering Interactive Deployment Mode...`);
        const topPairs = await scanPairs();

        if (topPairs && topPairs.length > 0) {
            console.log(`\n💡 Suggested Pairs:`);
            topPairs.forEach((p: any, i: number) => {
                console.log(`   [${i + 1}] ${p.Symbol} (Chop: ${p['Chop Score']}, Sug. Slippage: ${(p.suggestedSlippage * 100).toFixed(1)}%)`);
            });

            const selection = await askQuestion(`\nSelect a pair (1-${topPairs.length}) or enter a Symbol manually`, '1');
            const idx = parseInt(selection, 10) - 1;
            if (idx >= 0 && idx < topPairs.length) {
                symbol = topPairs[idx].Symbol;
                slippageRatio = topPairs[idx].suggestedSlippage.toString();
            } else {
                symbol = selection.toUpperCase();
            }
        } else {
            symbol = await askQuestion(`\nEnter Symbol (e.g. BTC-USDT-SWAP)`);
        }
    }

    let shouldRetry = true;
    while (shouldRetry) {
        if (args.length < 3) {
            // Re-prompt for values in interactive mode or on retry
            leverage = parseInt(await askQuestion(`Enter Leverage `, leverage.toString()), 10);
            marginUsdt = parseFloat(await askQuestion(`Enter Total Investment per Bot (USDT) `, marginUsdt.toString()));
            extraMarginUsdt = parseFloat(await askQuestion(`Enter ADDITIONAL Manual Safety Padding per Bot (USDT) `, extraMarginUsdt.toString()));
            slippageRatio = await askQuestion(`Enter Slippage Ratio (e.g. 0.001 for 0.1%) `, slippageRatio || '0.001');
        }

        console.log(`\n🚀 Initializing Dual Grid Strategy for ${symbol}...`);

        // --- PRE-FLIGHT CHECKS ---
        console.log(`\n⚙️ Ensuring Isolated Margin Mode for ${symbol}...`);
        const levRes = await okxRequest('POST', '/api/v5/account/set-leverage', {
            instId: symbol,
            lever: leverage.toString(),
            mgnMode: 'isolated'
        });

        if (levRes.code !== '0' && levRes.code !== '51019') {
            console.error(`\n❌ Failed to enforce Isolated Margin Mode / Leverage:`, levRes.msg);
            if (args.length < 3) {
                console.log(`\nRetrying parameter input...`);
                continue;
            }
            process.exit(1);
        }
        console.log(`✅ Isolated Margin Confirmed.`);

        // 1. Check wallet balance
        const balRes = await okxRequest('GET', '/api/v5/account/balance');
        if (balRes.code !== '0') {
            console.error(`\n❌ Failed to fetch balance:`, balRes.msg);
            process.exit(1);
        }
        const usdtDetails = balRes.data[0].details.find((d: any) => d.ccy === 'USDT');
        const availBal = usdtDetails ? parseFloat(usdtDetails.availBal) : 0;

        const TOTAL_WALLET_REQUIRED = (marginUsdt + extraMarginUsdt) * 2;
        if (availBal < TOTAL_WALLET_REQUIRED) {
            console.error(`\n❌ Insufficient Balance: You have $${availBal.toFixed(2)} USDT.`);
            console.error(`   You need at least $${TOTAL_WALLET_REQUIRED} USDT to deploy both bots.`);
            if (args.length < 3) continue;
            process.exit(1);
        }

        // 2. Instrument details
        const instRes = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${symbol}`);
        if (!instRes.data || instRes.data.length === 0) {
            console.error(`\n❌ Could not find pair: ${symbol}`);
            if (args.length < 3) {
                symbol = await askQuestion(`Enter Correct Symbol `);
                continue;
            }
            process.exit(1);
        }
        const instrument = instRes.data[0];
        const ctVal = parseFloat(instrument.ctVal);
        const tickSz = instrument.tickSz;
        const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;

        // 3. Prices
        const tickerRes = await okxRequest('GET', `/api/v5/market/ticker?instId=${symbol}`);
        const currentPrice = parseFloat(tickerRes.data[0].last);

        const fundingRes = await okxRequest('GET', `/api/v5/public/funding-rate?instId=${symbol}`);
        const currentFundingRate = fundingRes.data && fundingRes.data.length > 0
            ? parseFloat(fundingRes.data[0].fundingRate) * 100
            : 0;

        // 4. Calculations
        // OKX splits the total investment: 2/3 for orders (Active Margin), 1/3 for reserved (Extra Margin)
        const activeMargin = marginUsdt * (2 / 3);
        const reservedMargin = marginUsdt * (1 / 3);

        const notionalValue = activeMargin * leverage;
        const contractValueUSDT = currentPrice * ctVal;
        let totalContracts = Math.floor(notionalValue / contractValueUSDT);

        if (totalContracts < 1) {
            console.error(`\n❌ Margin too low! (0 contracts)`);
            if (args.length < 3) continue;
            process.exit(1);
        }

        const maxPx = currentPrice * (1 + gridPercentRange);
        const minPx = currentPrice * (1 - gridPercentRange);
        const gridRange = maxPx - minPx;

        const MIN_ABSOLUTE_PROFIT_USDT = 0.05;
        const FEE_THRESHOLD = 0.0012 * 2;
        let gridNum = 150;

        let expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
        let netAbsoluteProfitPerGrid = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_THRESHOLD);

        while (gridNum > 2 && (expectedProfitPerGrid <= FEE_THRESHOLD || netAbsoluteProfitPerGrid < MIN_ABSOLUTE_PROFIT_USDT)) {
            gridNum--;
            expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
            netAbsoluteProfitPerGrid = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_THRESHOLD);
        }

        if (expectedProfitPerGrid <= FEE_THRESHOLD || netAbsoluteProfitPerGrid < MIN_ABSOLUTE_PROFIT_USDT) {
            console.error(`\n❌ Profit too low with these settings!`);
            if (args.length < 3) continue;
            process.exit(1);
        }

        const bufferDistance = gridRange * bufferDistanceToClose;
        const longSL = minPx - bufferDistance;
        const longTP = maxPx + bufferDistance;
        const shortSL = maxPx + bufferDistance;
        const shortTP = minPx - bufferDistance;

        // Effective Leverage calculation accounts for BOTH OKX's automatic 1/3 reserved margin AND our manual padding
        const totalEffectiveMargin = marginUsdt + extraMarginUsdt;
        const effectiveLeverage = notionalValue / totalEffectiveMargin;
        const estLiqLong = ((currentPrice + minPx) / 2) * (1 - (1 / effectiveLeverage));
        const estLiqShort = ((currentPrice + maxPx) / 2) * (1 + (1 / effectiveLeverage));

        const reqLiqLong = longSL * (1 - liqPercentageDistance);
        const reqLiqShort = shortSL * (1 + liqPercentageDistance);

        if (estLiqLong > reqLiqLong || estLiqShort < reqLiqShort) {
            console.error(`\n❌ HIGH LIQUIDATION RISK DETECTED!`);
            if (args.length < 3) continue;
            process.exit(1);
        }

        // Validate OKX Min Investment
        const minInvestRes = await okxRequest('POST', '/api/v5/tradingBot/grid/min-investment', {
            instId: symbol,
            algoOrdType: 'contract_grid',
            runType: '2',
            maxPx: maxPx.toFixed(tickDecimals),
            minPx: minPx.toFixed(tickDecimals),
            gridNum: gridNum.toString(),
            direction: 'long',
            lever: leverage.toString()
        });

        if (minInvestRes.code !== '0') {
            console.error(`\n❌ Failed min-investment check:`, minInvestRes.msg);
            if (args.length < 3) continue;
            process.exit(1);
        }

        const minMarginRequired = parseFloat(minInvestRes.data[0].minInvestmentData[0].amt);
        if (marginUsdt < minMarginRequired) {
            console.error(`\n❌ Insufficient Margin! Required: $${minMarginRequired.toFixed(2)}`);
            if (args.length < 3) continue;
            process.exit(1);
        }

        // --- SUMMARY & CONFIRMATION ---
        console.log(`\n========================================`);
        console.log(`         DEPLOYMENT SUMMARY (${IS_SIMULATED ? 'DEMO' : 'LIVE'})        `);
        console.log(`========================================`);
        console.log(` Pair:              ${symbol} (Funding Rate: ${currentFundingRate.toFixed(5)}%)`);
        console.log(` Leverage:          ${leverage}x`);
        console.log(` Base Margin:  $${marginUsdt} USDT`);
        console.log(`   - Active Margin: $${activeMargin.toFixed(2)} USDT (for orders)`);
        console.log(`   - Reserved Marg: $${reservedMargin.toFixed(2)} USDT (OKX Auto-Padding)`);
        if (extraMarginUsdt > 0) {
            console.log(` Manual Extra:  $${extraMarginUsdt.toFixed(2)} USDT (Additional Padding)`);
        }
        console.log(` Effective Lever:   ${effectiveLeverage.toFixed(2)}x`);
        console.log(` Slippage Ratio:    ${slippageRatio ? (parseFloat(slippageRatio) * 100).toFixed(2) + '%' : 'Default'}`);
        console.log(` Grids per Bot:     ${gridNum}`);
        console.log(` Step Profit %:     ${(expectedProfitPerGrid * 100).toFixed(3)}%`);
        console.log(` Step Profit $:     $${netAbsoluteProfitPerGrid.toFixed(3)} USDT`);
        console.log(` Long SL:           ${longSL.toFixed(tickDecimals)} (Liq. Est: ${estLiqLong.toFixed(tickDecimals)})`);
        console.log(` Short SL:          ${shortSL.toFixed(tickDecimals)} (Liq. Est: ${estLiqShort.toFixed(tickDecimals)})`);
        console.log(` Total Pair Cost:   $${((marginUsdt + extraMarginUsdt) * 2).toFixed(2)} USDT`);
        console.log(`========================================`);

        const confirmed = await askConfirmation(`\nDeploy these dual bots on OKX? [y/N]`);
        if (!confirmed) {
            console.log(`\n❌ Deployment cancelled by user.`);
            if (args.length < 3) {
                const retry = await askConfirmation(`Modify parameters and retry? [y/N]`);
                if (retry) continue;
            }
            process.exit(0);
        }

        // --- BOT CREATION ---
        const createBot = async (direction: 'long' | 'short', sl: number, tp: number) => {
            const payload = {
                instId: symbol,
                algoOrdType: 'contract_grid',
                maxPx: maxPx.toFixed(tickDecimals),
                minPx: minPx.toFixed(tickDecimals),
                gridNum: gridNum.toString(),
                runType: '2',
                direction: direction,
                lever: leverage.toString(),
                sz: marginUsdt.toString(),
                slTriggerPx: sl.toFixed(tickDecimals),
                tpTriggerPx: tp.toFixed(tickDecimals),
                tdMode: 'isolated',
                slp: slippageRatio || undefined
            };

            const res = await okxRequest('POST', '/api/v5/tradingBot/grid/order-algo', payload);
            if (res.code === '0') {
                const algoId = res.data[0].algoId;
                console.log(`\n✅ ${direction.toUpperCase()} Bot Created: ${algoId}`);
                if (extraMarginUsdt > 0) {
                    await new Promise(r => setTimeout(r, 2000));
                    await okxRequest('POST', '/api/v5/tradingBot/grid/margin-balance', {
                        algoId: algoId,
                        type: 'add',
                        amt: extraMarginUsdt.toString()
                    });
                    console.log(`   🛡️ Added $${extraMarginUsdt} Padding.`);
                }
            } else {
                console.error(`\n❌ Failed to create ${direction.toUpperCase()} Bot:`, res.msg);
            }
        };

        console.log(`\n⚙️ Firing Off Bot API Calls...`);
        await createBot('long', longSL, longTP);
        await createBot('short', shortSL, shortTP);
        console.log(`\n🎉 Process Complete!`);
        shouldRetry = false;
    }
}

deployDualGrids();
