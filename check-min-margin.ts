import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

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

const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;
const BASE_URL = 'https://www.okx.com';

async function okxRequest(method: string, endpoint: string, bodyObj: any = null) {
    const timestamp = new Date().toISOString();
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    let queryEndpoint = endpoint;

    // For GET requests, the signature uses the endpoint including query string
    const preHash = timestamp + method.toUpperCase() + queryEndpoint + bodyStr;
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

async function checkMinMargin() {
    let symbol = process.argv[2];
    let levInput = process.argv[3];
    let rangeInput = process.argv[4];

    if (!symbol) {
        symbol = await askQuestion('Enter Symbol (e.g. BTC-USDT-SWAP)', 'BTC-USDT-SWAP');
    }
    const levStr = levInput || await askQuestion('Enter Leverage (e.g. 5, 10)', '5');
    const rangeStr = rangeInput || await askQuestion('Enter Range Percentage (e.g. 0.20, 0.30)', '0.20');
    
    let leverage = parseInt(levStr, 10);
    let rangePct = parseFloat(rangeStr);
    
    console.log(`\nFetching current price for ${symbol}...`);
    const tickerRes = await okxRequest('GET', `/api/v5/market/ticker?instId=${symbol}`);
    if (tickerRes.code !== '0' || !tickerRes.data || tickerRes.data.length === 0) {
        console.log(`Failed to fetch ticker for ${symbol}`);
        return;
    }
    
    const instrument = tickerRes.data[0];
    const currentPrice = parseFloat(instrument.last);
    console.log(`Current Price: $${currentPrice}`);
    
    // Fetch instrument tick size to correctly round maxPx and minPx
    const instRes = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${symbol}`);
    if (!instRes.data || instRes.data.length === 0) {
        console.log(`Failed to fetch instrument details for ${symbol}`);
        return;
    }
    const tickSz = instRes.data[0].tickSz;
    const tickDecimals = tickSz.includes('.') ? tickSz.split('.')[1].length : 0;
    
    const maxPx = (currentPrice * (1 + rangePct)).toFixed(tickDecimals);
    const minPx = (currentPrice * (1 - rangePct)).toFixed(tickDecimals);
    const gridNum = 150;
    
    console.log(`Calculating for Grid Range: $${minPx} - $${maxPx} (150 Grids)`);
    
    // Check Long Bot Required Investment
    const longPayload = {
        instId: symbol,
        algoOrdType: "contract_grid",
        maxPx: maxPx.toString(),
        minPx: minPx.toString(),
        gridNum: gridNum.toString(),
        runType: "1",
        lever: leverage.toString(),
        direction: "long"
    };
    const longRes = await okxRequest('POST', '/api/v5/tradingBot/grid/min-investment', longPayload);
    
    
    let longMin = 0;
    if (longRes.code === '0' && longRes.data && longRes.data.length > 0) {
        longMin = parseFloat(longRes.data[0].minInvestmentData[0].amt);
        console.log(`\n✅ Long Bot Minimum Investment:       $${longMin.toFixed(2)} USDT`);
    } else {
        console.log(`\n❌ Error fetching Long Min Margin: ${longRes.msg || JSON.stringify(longRes)}`);
    }
    
    // Check Short Bot Required Investment
    const shortPayload = {
        ...longPayload,
        runType: "2",
        direction: "short"
    };
    const shortRes = await okxRequest('POST', '/api/v5/tradingBot/grid/min-investment', shortPayload);
    
    let shortMin = 0;
    if (shortRes.code === '0' && shortRes.data && shortRes.data.length > 0) {
        shortMin = parseFloat(shortRes.data[0].minInvestmentData[0].amt);
        console.log(`✅ Short Bot Minimum Investment:      $${shortMin.toFixed(2)} USDT`);
    } else {
        console.log(`❌ Error fetching Short Min Margin: ${shortRes.msg || JSON.stringify(shortRes)}`);
    }
    
    if (longMin > 0 && shortMin > 0) {
        let totalPairCost = longMin + shortMin;
        console.log(`\n💰 TOTAL PAIR COST (Dual Grid 150):           $${totalPairCost.toFixed(2)} USDT`);
        console.log(`This is the absolute mathematical minimum required by OKX. You should add at least 15% extra to prevent instant liquidation buffer rejections.`);
    }
}

checkMinMargin();
