import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;
const BASE_URL = 'https://www.okx.com';

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
        return { code: '-1', msg: error.message };
    }
}

async function debugListBots() {
    console.log("--- DEBUG: Listing ALL Active Grid Algos ---");
    const res = await okxRequest('GET', '/api/v5/tradingBot/grid/orders-algo-list?algoOrdType=contract_grid');
    console.log(JSON.stringify(res, null, 2));
    
    if (res.code === '0' && res.data) {
        console.log(`\nFound ${res.data.length} potential bots.\n`);
        res.data.forEach((d: any) => {
            console.log(`- ID: ${d.algoId} | Inst: ${d.instId} | Dir: ${d.direction} | State: ${d.state}`);
        });
    }
}

debugListBots();
