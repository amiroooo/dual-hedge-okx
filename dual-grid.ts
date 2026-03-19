import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

function askConfirmation(query: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        resolve(ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes');
    }));
}

// npm start NEAR-USDT-SWAP 10 200 
// npx ts-node dual-grid.ts DOGE-USDT-SWAP 20 50

// ==========================================
// 1. CONFIGURATION & SETUP
// ==========================================
const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;

const gridPercentRange = Number(process.env.OKX_GRID_PERCENTAGE_RANGE) || 0.10;

const BASE_URL = 'https://www.okx.com';

// Parse command-line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error('❌ Error: Missing arguments.');
    console.error('Usage: npx ts-node dual-grid.ts <PAIR> <LEVERAGE> <MARGIN_USDT_PER_BOT>');
    console.error('Example (BTC, 10x Lev, 100 USDT per bot): npx ts-node dual-grid.ts BTC-USDT-SWAP 10 100');
    process.exit(1);
}

const SYMBOL = args[0];
const LEVERAGE = parseInt(args[1], 10);
const MARGIN_USDT = parseFloat(args[2]);

// Target Profit Config
const TARGET_PROFIT_USDT = 0.15;

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
        process.exit(1);
    }
}

// ==========================================
// 3. BOT LOGIC
// ==========================================

async function deployDualGrids() {
    console.log(`\n🚀 Initializing Dual Grid Strategy for ${SYMBOL}...`);
    console.log(`   -> Target Margin per Bot: $${MARGIN_USDT} USDT (${MARGIN_USDT * 2} USDT Total)`);
    console.log(`   -> Leverage: ${LEVERAGE}x`);

    console.log(`\n⚙️ Ensuring Isolated Margin Mode for ${SYMBOL}...`);
    const levRes = await okxRequest('POST', '/api/v5/account/set-leverage', {
        instId: SYMBOL,
        lever: LEVERAGE.toString(),
        mgnMode: 'isolated'
    });

    // 51019 is OKX's 'leverage has not changed' error code which can be ignored safely
    if (levRes.code !== '0' && levRes.code !== '51019') {
        console.error(`\n❌ Failed to enforce Isolated Margin Mode / Leverage:`, levRes.msg);
        process.exit(1);
    }
    console.log(`✅ Isolated Margin Confirmed.`);

    // 1. Check wallet balance
    const balRes = await okxRequest('GET', '/api/v5/account/balance');
    const usdtDetails = balRes.data[0].details.find((d: any) => d.ccy === 'USDT');
    const availBal = usdtDetails ? parseFloat(usdtDetails.availBal) : 0;

    if (availBal < (MARGIN_USDT * 2)) {
        console.error(`\n❌ Insufficient Balance: You have $${availBal.toFixed(2)} USDT.`);
        console.error(`   You need at least $${MARGIN_USDT * 2} USDT to deploy both bots.`);
        process.exit(1);
    }
    console.log(`✅ Balance OK. Available: $${availBal.toFixed(2)} USDT`);

    // 2. Fetch Instrument Details
    const instRes = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${SYMBOL}`);
    if (!instRes.data || instRes.data.length === 0) {
        console.error(`\n❌ Could not find pair: ${SYMBOL}`);
        process.exit(1);
    }
    const instrument = instRes.data[0];
    const ctVal = parseFloat(instrument.ctVal);
    const tickSz = instrument.tickSz;
    const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;

    // 3. Get Current Price
    const tickerRes = await okxRequest('GET', `/api/v5/market/ticker?instId=${SYMBOL}`);
    const currentPrice = parseFloat(tickerRes.data[0].last);

    // 4. Calculate Total Contracts based on USDT margin
    const notionalValue = MARGIN_USDT * LEVERAGE;
    const contractValueUSDT = currentPrice * ctVal;
    let totalContracts = Math.floor(notionalValue / contractValueUSDT);

    if (totalContracts < 1) {
        console.error(`\n❌ Margin too low!`);
        console.error(`   $${MARGIN_USDT} at ${LEVERAGE}x buys ${totalContracts} contracts.`);
        console.error(`   You need at least 2 contracts to create a Grid Bot. Increase Margin or Leverage.`);
        process.exit(1);
    }

    // 5. Calculate Grid Bounds
    const maxPx = currentPrice * (1 + gridPercentRange);
    const minPx = currentPrice * (1 - gridPercentRange);
    const gridRange = maxPx - minPx;

    // 6. Calculate Grid Number Based on Geometric Profit Limits
    // OKX Fees max out at ~0.1% round trip for VIP0 limits (0.05% taker * 2). We set minimum buffer to 0.12%.
    const FEE_THRESHOLD = 0.0012 * 2;
    let gridNum = 150;

    // Geometric grid ratio: (maxPx / minPx) ^ (1 / gridNum)
    let expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;

    // Step down grid number until we find one that is safely above the fee threshold, down to 75.
    while (gridNum > 75 && expectedProfitPerGrid <= FEE_THRESHOLD) {
        gridNum--;
        expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
    }

    if (expectedProfitPerGrid <= 0.001) { // Hard fail if below 0.1%
        console.error(`\n❌ Calculated Grid Profit (${(expectedProfitPerGrid * 100).toFixed(3)}%) is less than expected round-trip fees (~0.1%).`);
        console.error(`   Decrease Max grids or widen percentage range. Aborting.`);
        process.exit(1);
    }

    console.log(`\n📐 Calculated Trade Sizes:`);
    console.log(`   Contract Size: 1 contract = ${ctVal} ${SYMBOL.split('-')[0]}`);
    console.log(`   Automatically Selected Grids: ${gridNum}`);
    console.log(`   Expected Return per Grid Step: ${(expectedProfitPerGrid * 100).toFixed(3)}%`);

    // 7. Calculate TP and SL (80% buffer distance outside grid)
    const bufferDistance = gridRange * 0.8;
    const longSL = minPx - bufferDistance;
    const longTP = maxPx + bufferDistance;
    const shortSL = maxPx + bufferDistance;
    const shortTP = minPx - bufferDistance;

    // 8. Pre-flight Margin Verification (Check OKX Minimum Investment)
    console.log(`\n⚙️ Validating Margin Requirements...`);
    const minInvestRes = await okxRequest('POST', '/api/v5/tradingBot/grid/min-investment', {
        instId: SYMBOL,
        algoOrdType: 'contract_grid',
        runType: '2', // 2 = Geometric
        maxPx: maxPx.toFixed(tickDecimals),
        minPx: minPx.toFixed(tickDecimals),
        gridNum: gridNum.toString(),
        direction: 'long',
        lever: LEVERAGE.toString()
    });

    if (minInvestRes.code !== '0') {
        console.error(`\n❌ Failed to calculate minimum investment from OKX API:`, minInvestRes.msg);
        process.exit(1);
    }

    const minMarginRequired = parseFloat(minInvestRes.data[0].minInvestmentData[0].amt);
    if (MARGIN_USDT < minMarginRequired) {
        console.error(`\n❌ Insufficient Margin Allocation!`);
        console.error(`   Required minimum by OKX for these grid settings is: $${minMarginRequired.toFixed(2)} USDT per Bot.`);
        console.error(`   You only allocated: $${MARGIN_USDT} USDT per Bot.`);
        console.error(`   Please increase margin or decrease the number of Grids. Aborting.`);
        process.exit(1);
    }
    console.log(`✅ Margin check passed. Minimum required: $${minMarginRequired.toFixed(2)} USDT, Provided: $${MARGIN_USDT} USDT.`);

    // 9. Confirmation Prompt
    console.log(`\n========================================`);
    console.log(`         DEPLOYMENT SUMMARY (${IS_SIMULATED ? 'DEMO' : 'LIVE'})        `);
    console.log(`========================================`);
    console.log(` Pair:              ${SYMBOL}`);
    console.log(` Leverage:          ${LEVERAGE}x (Isolated)`);
    console.log(` Margin per Bot:    $${MARGIN_USDT} USDT`);
    console.log(` Min Required:      $${minMarginRequired.toFixed(2)} USDT`);
    console.log(` Total Margin:      $${MARGIN_USDT * 2} USDT`);
    console.log(` Grids per Bot:     ${gridNum} (Geometric)`);
    console.log(` Step Profit:       ${(expectedProfitPerGrid * 100).toFixed(3)}%`);
    console.log(` Long Bot SL:       $${longSL.toFixed(tickDecimals)}`);
    console.log(` Short Bot SL:      $${shortSL.toFixed(tickDecimals)}`);
    console.log(`========================================`);

    const confirmed = await askConfirmation(`\nDeploy these dual bots on OKX? [y/N]: `);
    if (!confirmed) {
        console.log(`\n❌ Deployment aborted by user.`);
        process.exit(0);
    }

    // 10. Bot Creation Function
    const createBot = async (direction: 'long' | 'short', sl: number, tp: number) => {

        const payload = {
            instId: SYMBOL,
            algoOrdType: 'contract_grid',
            maxPx: maxPx.toFixed(tickDecimals),
            minPx: minPx.toFixed(tickDecimals),
            gridNum: gridNum.toString(),
            runType: '2',            // 2 = Geometric
            direction: direction,
            lever: LEVERAGE.toString(),
            sz: MARGIN_USDT.toString(),
            slTriggerPx: sl.toFixed(tickDecimals),
            tpTriggerPx: tp.toFixed(tickDecimals)
        };

        const res = await okxRequest('POST', '/api/v5/tradingBot/grid/order-algo', payload);

        if (res.code === '0') {
            console.log(`\n✅ ${direction.toUpperCase()} Bot Created Successfully!`);
            console.log(`   ID: ${res.data[0].algoId}`);
            console.log(`   TP: $${tp.toFixed(tickDecimals)} | SL: $${sl.toFixed(tickDecimals)}`);
        } else {
            console.error(`\n❌ Failed to create ${direction.toUpperCase()} Bot:`, res.msg);
            console.error(res.data);
        }
    };



    // 10. Execute Deployments
    console.log(`\n⚙️ Firing Off Bot API Calls...`);
    await createBot('long', longSL, longTP);
    await createBot('short', shortSL, shortTP);

    console.log(`\n🎉 Process Complete! Both bots are now running on OKX servers.`);
}

// Run the application
deployDualGrids();