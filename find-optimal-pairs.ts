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
        // Silently fail for individual pair data to avoid crashing the whole scan
        return null;
    }
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function scanPairs() {
    console.log(`\n🔍 Scanning OKX SWAP Markets for Optimal Grid Bot Pairs...`);
    console.log(`   Criteria: High Volatility, Low 7d Range (<25%), Top Volume`);

    // 1. Fetch all SWAP tickers
    const res = await okxRequest('GET', '/api/v5/market/tickers?instType=SWAP');
    if (!res || res.code !== '0') {
        console.error('❌ Failed to fetch tickers.');
        return [];
    }

    // Filter by USDT pairs and Volume (e.g., > $50M)
    let pairs = res.data
        .filter((t: any) => t.instId.endsWith('-USDT-SWAP'))
        .map((t: any) => ({
            instId: t.instId,
            vol24h: parseFloat(t.vol24h),
            volCcy24h: parseFloat(t.volCcy24h),
            last: parseFloat(t.last)
        }))
        .filter((t: any) => t.volCcy24h > 50000000) // 50M USDT Volume
        .sort((a: any, b: any) => b.volCcy24h - a.volCcy24h)
        .slice(0, 40); // Scan top 40 for speed and rate limits

    console.log(`📊 Analysis started for ${pairs.length} highly liquid pairs...`);

    const results: any[] = [];

    for (const pair of pairs) {
        process.stdout.write(`⏳ Analysing ${pair.instId}... `);

        // Fetch 7 days of 1H candles
        const candleRes = await okxRequest('GET', `/api/v5/market/candles?instId=${pair.instId}&bar=1H&limit=168`);
        const fundingRes = await okxRequest('GET', `/api/v5/public/funding-rate?instId=${pair.instId}`);

        if (candleRes && candleRes.code === '0' && fundingRes && fundingRes.code === '0') {
            const candles = candleRes.data; // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
            
            let maxPrice = 0;
            let minPrice = Infinity;
            let totalPath = 0;
            let prevClose = parseFloat(candles[candles.length - 1][4]);

            for (const c of candles) {
                const high = parseFloat(c[2]);
                const low = parseFloat(c[3]);
                const close = parseFloat(c[4]);

                if (high > maxPrice) maxPrice = high;
                if (low < minPrice) minPrice = low;
                
                totalPath += Math.abs(close - prevClose);
                prevClose = close;
            }

            const rangePct = (maxPrice - minPrice) / minPrice;
            const fundingRate = parseFloat(fundingRes.data[0].fundingRate);
            const chopScore = totalPath / (maxPrice - minPrice || 1);

            // Suggested Slippage based on Volume
            let suggestedSlippage = 0.01; // Default 1%
            if (pair.volCcy24h > 500000000) suggestedSlippage = 0.001; // 0.1%
            else if (pair.volCcy24h > 100000000) suggestedSlippage = 0.002; // 0.2%
            else if (pair.volCcy24h > 50000000) suggestedSlippage = 0.005; // 0.5%

            // Only consider pairs that stayed roughly within a reasonable range (e.g., < 25% total 7d swing)
            if (rangePct < 0.25) {
                results.push({
                    Symbol: pair.instId,
                    'Range (7d)': `${(rangePct * 100).toFixed(2)}%`,
                    'Chop Score': chopScore.toFixed(2),
                    'Funding': `${(fundingRate * 100).toFixed(4)}%`,
                    vol: pair.volCcy24h,
                    score: parseFloat(chopScore.toFixed(2)),
                    suggestedSlippage: suggestedSlippage
                });
                process.stdout.write(`✅ Done\n`);
            } else {
                process.stdout.write(`⚠️ Range too wide (${(rangePct * 100).toFixed(1)}%)\n`);
            }
        } else {
            process.stdout.write(`❌ API Error\n`);
        }
        
        // Small sleep to be nice to API
        await sleep(100);
    }

    console.log(`\n================================================================================`);
    console.log(`🏆 TOP 10 RECOMMENDED PAIRS FOR DUAL GRID (±10% Range)`);
    console.log(`Higher Chop Score = More entries/exits within the range (Better for Grid)`);
    console.log(`================================================================================`);
    
    const top10 = results
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    console.table(top10.map(r => ({
        Symbol: r.Symbol,
        'Range (7d)': r['Range (7d)'],
        'Chop Score': r['Chop Score'],
        'Funding Rate': r['Funding'],
        'Sug. Slippage': `${(r.suggestedSlippage * 100).toFixed(1)}% (${r.suggestedSlippage})`
    })));

    console.log(`\n💡 How to use: Pick a pair with high Chop Score and low/positive Funding.`);
    console.log(`   Slippage Info: Higher volume = lower slippage. Use 'Sug. Slippage' in dual-grid.ts.`);
    
    return top10;
}

import { fileURLToPath } from 'url';
import { resolve } from 'path';

// Run if script executed directly
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
    scanPairs();
}
