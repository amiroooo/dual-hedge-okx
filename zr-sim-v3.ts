import * as fs from 'fs';

const SCENARIOS = 100000;
const CYCLES_PER_SCENARIO = 100; // Sequence of trades to survive
const INITIAL_USDT = 1000;
const TARGET_PROFIT_USDT = 2.0; // Aim for $2 per cycle

const INITIAL_PRICE = 10000;
const MAX_REVERSALS = 5;
const TICK_PCT = 0.005; 

function runSimulation() {
    let scenariosSurvived = 0;
    let scenariosFailed = 0;
    let finalBalances: number[] = [];
    let maxDrawdownPctGlobal = 0;
    
    for (let s = 0; s < SCENARIOS; s++) {
        let balance = INITIAL_USDT;
        let survived = true;
        let price = INITIAL_PRICE;
        
        for (let cycle = 0; cycle < CYCLES_PER_SCENARIO; cycle++) {
            if (!survived) break;
            
            let cycleStartBalance = balance;
            let maxLossThisCycle = 0;
            
            let direction = 1;
            let TP_high = price * 1.01;
            let SL_low = price * 0.98;
            let revDown = price * (1 - 0.012);
            let revUp = price;
            
            let targetPx = TP_high;
            let slPx = SL_low;
            let revPx = revDown;
            
            let realizedPnl = 0;
            let legs: {dir: number, entry: number, sz: number}[] = [];
            
            let distToTarget = Math.abs(targetPx - price); 
            let minSz = TARGET_PROFIT_USDT / distToTarget; 
            legs.push({dir: direction, entry: price, sz: minSz});
            
            let legCount = 1;
            let active = true;
            let iter = 0;
            
            while (active && iter < 10000) {
                iter++;
                price = price * (1 + (Math.random() < 0.5 ? TICK_PCT : -TICK_PCT));
                
                let unrealized = legs.reduce((acc, leg) => acc + (leg.dir * (price - leg.entry) * leg.sz), 0);
                let equity = balance + realizedPnl + unrealized;
                
                let loss = cycleStartBalance - equity;
                let lossPct = (loss / cycleStartBalance) * 100;
                if (lossPct > maxLossThisCycle) maxLossThisCycle = lossPct;
                
                if (equity <= 0) {
                    survived = false;
                    balance = 0;
                    break;
                }
                
                let hitTarget = (direction === 1 && price >= targetPx) || (direction === -1 && price <= targetPx);
                let hitRev = (legCount < MAX_REVERSALS) && ((direction === 1 && price <= revPx) || (direction === -1 && price >= revPx));
                let hitSl = (legCount >= MAX_REVERSALS) && ((direction === 1 && price <= slPx) || (direction === -1 && price >= slPx));
                
                if (hitTarget) {
                    balance += realizedPnl + unrealized;
                    active = false;
                } else if (hitSl) {
                    balance += realizedPnl + unrealized;
                    if (balance <= 0) { survived = false; balance = 0; }
                    active = false;
                } else if (hitRev) {
                    direction = -direction;
                    legCount++;
                    
                    let revPriceActual = direction === 1 ? revUp : revDown;
                    let targetPxNew = direction === 1 ? TP_high : SL_low;
                    let slPxNew = direction === 1 ? SL_low : TP_high;
                    let revPxNew = direction === 1 ? revDown : revUp;
                    
                    targetPx = targetPxNew;
                    slPx = slPxNew;
                    revPx = revPxNew;
                    
                    let unrealizedAtTarget = legs.reduce((acc, leg) => acc + (leg.dir * (targetPx - leg.entry) * leg.sz), 0);
                    let netNeeded = TARGET_PROFIT_USDT - realizedPnl - unrealizedAtTarget;
                    let dist = Math.abs(targetPx - revPriceActual);
                    let szNeeded = netNeeded / dist;
                    
                    if (legCount >= 3) {
                        szNeeded *= 0.5; // Aggression Dampening
                    }
                    if (szNeeded < minSz) szNeeded = minSz;
                    
                    legs.push({dir: direction, entry: revPriceActual, sz: szNeeded});
                }
            }
            if (iter >= 10000) { survived = false; balance=0; } 
            
            if (maxLossThisCycle > maxDrawdownPctGlobal) maxDrawdownPctGlobal = maxLossThisCycle;
        }
        
        if (survived && balance > 0) scenariosSurvived++;
        else scenariosFailed++;
        
        finalBalances.push(balance);
    }
    
    let sumBal = finalBalances.reduce((a,b)=>a+b,0);
    let avgBal = sumBal / SCENARIOS;
    
    finalBalances.sort((a,b)=>a-b);
    let medianBal = finalBalances[Math.floor(SCENARIOS/2)];
    let worstCase = finalBalances[0];
    let bestCase = finalBalances[SCENARIOS-1];
    
    const res = [{
        "Strategy": "Aggression Dampening (100k)",
        "Survival (%)": parseFloat(((scenariosSurvived / SCENARIOS) * 100).toFixed(2)),
        "Avg End": parseFloat(avgBal.toFixed(2)),
        "Median End": parseFloat(medianBal.toFixed(2)),
        "Worst End": parseFloat(worstCase.toFixed(2)),
        "Best End": parseFloat(bestCase.toFixed(2)),
        "Peak Drawdown (%)": parseFloat(maxDrawdownPctGlobal.toFixed(2))
    }];
    
    console.table(res);
    fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/brain/72cccc12-7528-48ca-a7d2-3862d81002f0/artifacts/sim_100k_damp.json', JSON.stringify(res, null, 2));
}

console.log(`Running massive stress test: 100,000 scenarios, 100 continuous cycles each...`);
runSimulation();
