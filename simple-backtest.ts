import * as fs from 'fs';

const FILENAME = 'btc-1m-klines.csv';
const INITIAL_USDT = 1000;
const TP_PCT = 0.02;      // 2% TP (2x)
const SL_PCT = 0.01;      // 1% SL (1x)
const TARGET_PROFIT = 20; // $20 per win, $10 risk

// OKX VIP0 Fees
const TAKER_FEE_PCT = 0.0005;
const MAKER_FEE_PCT = 0.0002;
const FUNDING_FEE_PCT = 0.00005; 
const FUNDING_INTERVAL = 480;

function runScenario(lines: string[], startIndex: number, id: number) {
    let balance = INITIAL_USDT;
    let survived = true;
    let wins = 0;
    let losses = 0;
    
    let activeLines = lines.slice(startIndex);
    let state = 'WAITING';
    
    let entryPx = 0;
    let tpPx = 0;
    let slPx = 0;
    let sz = 0;
    
    for (let i = 0; i < activeLines.length; i++) {
        if (!survived) break;
        let cols = activeLines[i].split(',');
        if (cols.length < 5) continue;
        
        let o = parseFloat(cols[1]);
        let h = parseFloat(cols[2]);
        let l = parseFloat(cols[3]);
        
        if (state === 'WAITING') {
            entryPx = o;
            tpPx = entryPx * (1 + TP_PCT);
            slPx = entryPx * (1 - SL_PCT);
            
            sz = TARGET_PROFIT / (entryPx * TP_PCT);
            
            balance -= (sz * entryPx) * TAKER_FEE_PCT; // fee to open
            state = 'ACTIVE';
            continue;
        }
        
        if (state === 'ACTIVE') {
            if (i > 0 && i % FUNDING_INTERVAL === 0) balance -= (sz * o) * FUNDING_FEE_PCT;
            
            // If both hit, assume SL hit to be rigorously conservative
            let hitTarget = h >= tpPx;
            let hitSl = l <= slPx;
            
            if (hitSl) {
                let exitPrice = slPx; 
                balance -= (sz * entryPx * SL_PCT); // The actual PnL loss
                balance -= (sz * exitPrice) * TAKER_FEE_PCT; // fee to close limit
                if (balance <= 0) { survived = false; }
                losses++;
                state = 'WAITING';
            } else if (hitTarget) {
                let exitPrice = tpPx;
                balance += (sz * entryPx * TP_PCT); // The actual PnL win
                balance -= (sz * exitPrice) * MAKER_FEE_PCT; // fee to close maker
                wins++;
                state = 'WAITING';
            }
        }
    }
    
    return { id, survived, balance, wins, losses };
}

function runMaster() {
    if (!fs.existsSync(FILENAME)) {
        console.log("Klines not downloaded yet!");
        return;
    }
    let fileStr = fs.readFileSync(FILENAME, 'utf-8').trim();
    let lines = fileStr.split('\n');
    lines.shift(); 
    lines.reverse(); 
    
    let stepAmount = Math.floor(lines.length / 50);
    
    let results = [];
    for (let i = 0; i < 10; i++) {
        let offset = i * stepAmount;
        results.push(runScenario(lines, offset, i+1));
    }
    
    console.log(`\n=== SIMPLE 2:1 R/R STRATEGY BACKTEST ===`);
    console.log(`TP: +2%, SL: -1%. (Always Long)`);
    console.log(`Target: $20 win, $10 risk. Starting Balance: $1000`);
    console.log(`==========================================`);
    let totalBal = 0;
    for (let r of results) {
        let wr = r.wins + r.losses > 0 ? (r.wins / (r.wins + r.losses)) * 100 : 0;
        console.log(`Test ${r.id} | Surv: ${r.survived?'YES':'NO '} | End: $${r.balance.toFixed(2)} | W: ${r.wins} L: ${r.losses} | WinRate: ${wr.toFixed(1)}%`);
        totalBal += r.balance;
    }
    console.log(`Average Ending Balance: $${(totalBal/10).toFixed(2)}`);
}

runMaster();
