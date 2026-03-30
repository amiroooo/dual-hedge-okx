import axios from 'axios';
import * as fs from 'fs';

const CONFIG_FILE = 'zr-config.json';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const END_TIME = Date.now();
const START_TIME = END_TIME - (YEAR_MS / 2); // 6 months

async function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function downloadKlinesForPair(symbol: string) {
    const filename = `${symbol.toLowerCase()}-1m-klines.csv`;
    let currentAfter = '';
    let fetched = 0;
    
    fs.writeFileSync(filename, 'ts,o,h,l,c,vol\n');
    let lastTs = END_TIME;

    console.log(`\n======================================================`);
    console.log(`[${symbol}] Starting download backwards 6 months...`);
    console.log(`Target Date: ${new Date(START_TIME).toISOString()}`);

    // OKX Rate Limit for history-candles is 10 req / 2s -> 5 req / sec.
    while (lastTs > START_TIME) {
        try {
            let url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=1m`;
            if (currentAfter) url += `&after=${currentAfter}`;
            
            const res = await axios.get(url, {timeout: 10000});
            if (res.data?.code === '0' && res.data?.data?.length > 0) {
                let lines = '';
                for (let k of res.data.data) {
                    lines += `${k[0]},${k[1]},${k[2]},${k[3]},${k[4]},${k[5]}\n`;
                    lastTs = parseInt(k[0]);
                }
                fs.appendFileSync(filename, lines);
                fetched += res.data.data.length;
                currentAfter = res.data.data[res.data.data.length - 1][0];
                
                if (fetched % 20000 === 0) {
                    console.log(`[${symbol}] Fetched ${fetched} candles... Reached ${new Date(lastTs).toISOString()}`);
                }
            } else {
                console.log(`[${symbol}] Data end reached or error response:`, res.data ? res.data : 'timeout');
                break;
            }
        } catch (e: any) {
            console.error(`[${symbol}] API Error: ${e.message}. Backing off 5s...`);
            await delay(5000); 
        }
        await delay(200); // 5 req/sec
    }
    console.log(`✅ [${symbol}] Complete. Total: ${fetched} candles. Earliest Date: ${new Date(lastTs).toISOString()}`);
}

async function runMaster() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error(`Config file ${CONFIG_FILE} not found!`);
        return;
    }
    
    let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    let pairs = config.pairs;
    
    console.log(`Starting massive batch download for ${pairs.length} pairs...`);
    
    for (let p of pairs) {
        const sym = p.instId;
        await downloadKlinesForPair(sym);
    }
    
    console.log(`\n🎉 ALL PAIRS FINISHED EXECUTING DOWNLOADS!`);
}

runMaster();
