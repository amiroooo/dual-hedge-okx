import * as fs from 'fs';

const FILENAME = 'btc-1m-klines.csv';
const TARGET_PROFIT_USDT = 2.0;
const INITIAL_USDT = 1000;
const MAX_REVERSALS = 5;
const AGGRESSION_PCT = 0.5;

async function runBacktest() {
    if (!fs.existsSync(FILENAME)) {
        console.log("Klines not downloaded yet!");
        return;
    }
    console.log("Loading and reversing klines for chronological parsing...");
    let fileStr = fs.readFileSync(FILENAME, 'utf-8').trim();
    let lines = fileStr.split('\n');
    lines.shift(); // remove header
    // The downloader appends backwards in time chronologically decreasing chunks 
    // Wait, the API returns [newest, older, oldest] in one chunk.
    // If we append chunk by chunk, we have [N...O] [O-1...OO] etc.
    // Meaning the entire file is strictly Newest to Oldest!
    // Reversing the lines array restores it perfectly to Oldest -> Newest.
    lines.reverse(); 

    let balance = INITIAL_USDT;
    let survived = true;
    let totalCycles = 0;
    
    let state = 'WAITING'; 
    let direction = 1;
    let TP_high = 0;
    let SL_low = 0;
    let revDown = 0;
    let revUp = 0;
    
    let targetPx = 0;
    let slPx = 0;
    let revPx = 0;
    
    let realizedPnl = 0;
    let legs: {dir: number, entry: number, sz: number}[] = [];
    let legCount = 1;
    let maxDrawdownGlobal = 0;
    let cycleStartBalance = balance;

    for (let i = 0; i < lines.length; i++) {
        if (!survived) break;
        
        let cols = lines[i].split(',');
        if (cols.length < 5) continue;
        let o = parseFloat(cols[1]);
        let h = parseFloat(cols[2]);
        let l = parseFloat(cols[3]);
        let c = parseFloat(cols[4]);
        
        if (state === 'WAITING') {
            cycleStartBalance = balance;
            realizedPnl = 0;
            legs = [];
            direction = 1; 
            legCount = 1;
            
            let price = o;
            
            TP_high = price * 1.01;
            SL_low = price * 0.98;
            revDown = price * (1 - 0.012);
            revUp = price;
            
            targetPx = TP_high;
            slPx = SL_low;
            revPx = revDown;
            
            let distToTarget = Math.abs(targetPx - price);
            let minSz = TARGET_PROFIT_USDT / distToTarget; 
            if (minSz < 0) minSz = 0;
            legs.push({dir: direction, entry: price, sz: minSz});
            
            state = 'ACTIVE';
        }
        
        if (state === 'ACTIVE') {
            let worstPrice = direction === 1 ? l : h;
            let unrealizedWorst = legs.reduce((acc, leg) => acc + (leg.dir * (worstPrice - leg.entry) * leg.sz), 0);
            let equity = balance + realizedPnl + unrealizedWorst;
            let drawPct = ((cycleStartBalance - equity) / cycleStartBalance) * 100;
            if (drawPct > maxDrawdownGlobal) maxDrawdownGlobal = drawPct;
            
            if (equity <= 0) {
                console.log(`LIQUIDATED at candle ${new Date(parseInt(cols[0])).toISOString()}! Equity hit $${equity.toFixed(2)}`);
                survived = false;
                break;
            }

            let hitTarget = (direction === 1 && h >= targetPx) || (direction === -1 && l <= targetPx);
            let hitRev = (legCount < MAX_REVERSALS) && ((direction === 1 && l <= revPx) || (direction === -1 && h >= revPx));
            let hitSl = (legCount >= MAX_REVERSALS) && ((direction === 1 && l <= slPx) || (direction === -1 && h >= slPx));

            if (hitRev) {
                direction = -direction;
                legCount++;
                
                let revPriceActual = direction === 1 ? revUp : revDown;
                
                targetPx = direction === 1 ? TP_high : SL_low;
                slPx = direction === 1 ? SL_low : TP_high;
                revPx = direction === 1 ? revDown : revUp;
                
                let unrealizedAtTarget = legs.reduce((acc, leg) => acc + (leg.dir * (targetPx - leg.entry) * leg.sz), 0);
                let netNeeded = TARGET_PROFIT_USDT - realizedPnl - unrealizedAtTarget;
                
                let dist = Math.abs(targetPx - revPriceActual);
                let szNeeded = netNeeded / dist;
                
                if (legCount >= 3) {
                    szNeeded *= AGGRESSION_PCT;
                }
                let minSz = TARGET_PROFIT_USDT / (TP_high - revUp);
                if (szNeeded < minSz) szNeeded = minSz;
                
                legs.push({dir: direction, entry: revPriceActual, sz: szNeeded});
            } 
            else if (hitTarget) {
                let unrealized = legs.reduce((acc, leg) => acc + (leg.dir * (targetPx - leg.entry) * leg.sz), 0);
                balance += realizedPnl + unrealized;
                totalCycles++;
                state = 'WAITING';
            } 
            else if (hitSl) {
                let unrealized = legs.reduce((acc, leg) => acc + (leg.dir * (slPx - leg.entry) * leg.sz), 0);
                balance += realizedPnl + unrealized;
                if (balance <= 0) survived = false;
                totalCycles++;
                state = 'WAITING';
            }
        }
    }
    
    console.log(`\n\n=== OVERALL HISTORICAL BACKTEST RESULT ===`);
    console.log(`Range: OKX BTC-USDT-SWAP 1M Candles`);
    console.log(`Total Candles Evaluated: ${lines.length}`);
    console.log(`Strategy: Option 4 (Base Hedged + 50% Dampening on Leg 3+)`);
    console.log(`Starting Balance: $1000 USDT`);
    console.log(`==========================================`);
    console.log(`Final Condition: ${survived ? 'SURVIVED' : 'LIQUIDATED'}`);
    console.log(`Final Balance: $${balance.toFixed(2)} USDT`);
    console.log(`Total Cycles Completed: ${totalCycles}`);
    console.log(`Absolute Peak Equity Drawdown: ${maxDrawdownGlobal.toFixed(2)}%\n`);
    
    // writing the result to disk so we can see it in terminal or UI later
    fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/brain/72cccc12-7528-48ca-a7d2-3862d81002f0/artifacts/real_backtest_output.txt', 
        `Condition: ${survived ? 'SURVIVED' : 'LIQUIDATED'}\n` +
        `Final Balance: $${balance.toFixed(2)} USDT\n` + 
        `Cycles: ${totalCycles}\n` + 
        `Peak Drawdown: ${maxDrawdownGlobal.toFixed(2)}%\n` + 
        `Candles Parsed: ${lines.length}\n`
    );
}

runBacktest();
