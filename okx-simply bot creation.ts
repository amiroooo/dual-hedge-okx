import axios from 'axios';
import * as crypto from 'crypto';

// ==========================================
// 1. OKX API CREDENTIALS
// ==========================================
const API_KEY = 'YOUR_OKX_API_KEY';
const API_SECRET = 'YOUR_OKX_API_SECRET';
const API_PASSPHRASE = 'Germanium123$';

// OKX uses the same base URL for Mainnet and Testnet.
// We use a special Header to tell OKX to route it to the Testnet (Demo Trading).
const BASE_URL = 'https://www.okx.com';

// ==========================================
// 2. OKX SIGNATURE GENERATOR
// ==========================================
function generateOkxHeaders(method: string, requestPath: string, body: string = '') {
    const timestamp = new Date().toISOString();
    
    // OKX Signature format: timestamp + method + requestPath + body
    const preHash = timestamp + method.toUpperCase() + requestPath + body;
    
    const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(preHash)
        .digest('base64'); // OKX requires base64

    return {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': API_PASSPHRASE,
        'Content-Type': 'application/json',
        'x-simulated-trading': '1' // 🟢 THIS ROUTES THE REQUEST TO OKX TESTNET
    };
}

// ==========================================
// 3. CREATE THE FUTURES GRID BOT
// ==========================================
async function createOkxFuturesGridBot() {
    const endpoint = '/api/v5/tradingBot/grid/order-algo';
    
    // The exact parameters for the OKX Grid Bot
    const payload = {
        instId: 'BTC-USDT-SWAP', // OKX format for Futures pairs
        algoOrdType: 'contract_grid', // Specifies a Futures Grid
        maxPx: '50000',          // Upper price of the grid
        minPx: '40000',          // Lower price of the grid
        gridNum: '10',           // Number of grids
        runType: '1',            // 1 = Arithmetic grid, 2 = Geometric grid
        direction: 'long',       // 'long', 'short', or 'neutral'
        lever: '10',             // 10x Leverage
        sz: '10',                // Investment amount (Number of contracts)
        tpTriggerPx: '52000',    // Global Take Profit
        slTriggerPx: '38000'     // Global Stop Loss
    };

    const bodyString = JSON.stringify(payload);
    const headers = generateOkxHeaders('POST', endpoint, bodyString);

    try {
        console.log('🚀 Sending command to OKX servers to build and run the bot...');
        
        const response = await axios({
            method: 'POST',
            url: `${BASE_URL}${endpoint}`,
            headers: headers,
            data: bodyString
        });

        const data = response.data;

        if (data.code === '0') {
            console.log('\n✅ SUCCESS! OKX Servers have taken over.');
            console.log(`🤖 Bot ID (algoId): ${data.data[0].algoId}`);
            console.log('You can now close your terminal, turn off your PC, and let OKX do the rest!');
        } else {
            console.error('\n❌ OKX API Rejected the Request:');
            console.error(data.msg);
        }

    } catch (error: any) {
        console.error('\n🛑 HTTP Request Error:');
        console.error(error.response ? error.response.data : error.message);
    }
}

// Run the function
createOkxFuturesGridBot();