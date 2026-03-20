import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

const IS_SIMULATED = process.env.OKX_TEST === 'true';
const API_KEY = IS_SIMULATED ? process.env.OKX_API_KEY_TEST as string : process.env.OKX_API_KEY_LIVE as string;
const API_SECRET = IS_SIMULATED ? process.env.OKX_API_SECRET_TEST as string : process.env.OKX_API_SECRET_LIVE as string;
const API_PASSPHRASE = process.env.OKX_API_PASSPHRASE as string;

const BASE_URL = 'https://www.okx.com';

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
        console.error(`\n❌ OKX API Error [${endpoint}]:`);
        console.error(error.response?.data || error.message);
        return null;
    }
}

async function manageBots() {
    console.log(`\n🤖 OKX Grid Bot Manager (${IS_SIMULATED ? 'DEMO' : 'LIVE'})`);
    console.log(`🔍 Fetching active contract grid bots...`);

    const res = await okxRequest('GET', '/api/v5/tradingBot/grid/orders-algo-pending?algoOrdType=contract_grid');
    if (!res || res.code !== '0') {
        console.error('❌ Failed to fetch active bots.');
        return;
    }

    const bots = res.data;
    if (bots.length === 0) {
        console.log('✅ No active grid bots found.');
        return;
    }

    // Group by pair
    const groups: Record<string, any[]> = {};
    for (const bot of bots) {
        if (!groups[bot.instId]) groups[bot.instId] = [];
        groups[bot.instId].push(bot);
    }

    console.log(`\n📊 ACTIVE BOT SUMMARY:`);
    const tableData: any[] = [];
    const allBotsToStop: any[] = [];

    for (const instId in groups) {
        const pairBots = groups[instId];
        let totalPnlVal = 0;
        let totalMargin = 0;
        const details: string[] = [];

        for (const b of pairBots) {
            const pnl = parseFloat(b.totalPnl || '0');
            const margin = parseFloat(b.sz || '0');
            totalPnlVal += pnl;
            totalMargin += margin;
            details.push(`${b.direction.toUpperCase()} ($${pnl.toFixed(2)})`);
            allBotsToStop.push({ algoId: b.algoId, instId: b.instId });
        }

        tableData.push({
            Pair: instId,
            Bots: details.join(' | '),
            'Total Margin': `$${totalMargin.toFixed(2)}`,
            'Total PnL': `$${totalPnlVal.toFixed(2)}`,
            'PnL %': `${((totalPnlVal / totalMargin) * 100).toFixed(3)}%`
        });
    }

    console.table(tableData);

    const totalPortfolioPnl = tableData.reduce((sum, row) => sum + parseFloat(row['Total PnL'].replace('$', '')), 0);
    console.log(`\n📈 Aggregate Portfolio PnL: $${totalPortfolioPnl.toFixed(2)} USDT`);

    const confirmed = await askConfirmation(`\n⚠️  DANGER: Do you want to STOP ALL ${bots.length} bots and CLOSE ALL POSITIONS? [y/N]: `);
    
    if (confirmed) {
        console.log(`\n🛑 Terminating all bots and closing positions...`);
        for (const bot of allBotsToStop) {
            process.stdout.write(`⏳ Stopping Bot ${bot.algoId} (${bot.instId})... `);
            const stopRes = await okxRequest('POST', '/api/v5/tradingBot/grid/stop-order-algo', [{
                algoId: bot.algoId,
                instId: bot.instId,
                algoOrdType: 'contract_grid',
                stopType: '1' // 1: Sell all or buy all to close position
            }]);

            if (stopRes && stopRes.code === '0') {
                console.log(`✅ Success`);
            } else {
                console.log(`❌ Failed: ${stopRes?.msg || 'Unknown error'}`);
            }
        }
        console.log(`\n🎉 All bots processed.`);
    } else {
        console.log(`\nOperation cancelled. Bots are still running.`);
    }
}

manageBots();
