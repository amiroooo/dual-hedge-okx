import * as fs from 'fs';

const SCENARIOS = 10000;
const CYCLES_PER_SCENARIO = 100; // Sequence of trades to survive
const INITIAL_USDT = 1000;
const TARGET_PROFIT_USDT = 2.0; // Aim for $2 per cycle

const INITIAL_PRICE = 10000;
const MAX_REVERSALS = 5;
const TICK_PCT = 0.005; // 0.5% jump per iter for massive speedup

interface SimConfig {
    name: string;
    stopAndReverse: boolean;
    dynamicTargets: boolean;
    aggression: number;
}

function runSimulation(config: SimConfig) {
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
                
                // LIQUIDATION CHECK
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
                    if (config.dynamicTargets) revPriceActual = price;
                    
                    if (config.stopAndReverse) {
                        realizedPnl += unrealized;
                        legs = [];
                        unrealized = 0;
                    }
                    
                    if (config.dynamicTargets) {
                        let w = INITIAL_PRICE * 0.012; 
                        let t = w * 2;         
                        targetPx = direction === 1 ? revPriceActual + t : revPriceActual - t;
                        slPx = direction === 1 ? revPriceActual - w : revPriceActual + w;
                        revPx = direction === 1 ? revPriceActual - w : revPriceActual + w; 
                    } else {
                        targetPx = direction === 1 ? TP_high : SL_low;
                        slPx = direction === 1 ? SL_low : TP_high;
                        revPx = direction === 1 ? revDown : revUp;
                    }
                    
                    let unrealizedAtTarget = legs.reduce((acc, leg) => acc + (leg.dir * (targetPx - leg.entry) * leg.sz), 0);
                    let netNeeded = TARGET_PROFIT_USDT - realizedPnl - unrealizedAtTarget;
                    let dist = Math.abs(targetPx - revPriceActual);
                    let szNeeded = netNeeded / dist;
                    
                    if (legCount >= 3) szNeeded *= config.aggression;
                    if (szNeeded < minSz) szNeeded = minSz;
                    
                    legs.push({dir: direction, entry: revPriceActual, sz: szNeeded});
                }
            }
            if (iter >= 10000) { survived = false; balance=0; } // timeout fail 
            
            if (maxLossThisCycle > maxDrawdownPctGlobal) maxDrawdownPctGlobal = maxLossThisCycle;
        }
        
        if (survived && balance > 0) scenariosSurvived++;
        else scenariosFailed++;
        
        finalBalances.push(balance);
    }
    
    let sumBal = finalBalances.reduce((a,b)=>a+b,0);
    let avgBal = sumBal / SCENARIOS;
    // median
    finalBalances.sort((a,b)=>a-b);
    let medianBal = finalBalances[Math.floor(SCENARIOS/2)];
    
    return {
        "Strategy": config.name,
        "Survival Rate (%)": parseFloat(((scenariosSurvived / SCENARIOS) * 100).toFixed(2)),
        "Avg End USDT": parseFloat(avgBal.toFixed(2)),
        "Median End USDT": parseFloat(medianBal.toFixed(2)),
        "Peak Drawdown (%)": parseFloat(maxDrawdownPctGlobal.toFixed(2))
    };
}

const configs: SimConfig[] = [
    { name: "1. Base Hedged", stopAndReverse: false, dynamicTargets: false, aggression: 1.0 },
    { name: "2. Stop-and-Reverse", stopAndReverse: true, dynamicTargets: false, aggression: 1.0 },
    { name: "3. Dynamic Targets", stopAndReverse: false, dynamicTargets: true, aggression: 1.0 },
    { name: "4. Aggression Dampening", stopAndReverse: false, dynamicTargets: false, aggression: 0.5 },
    { name: "5. Stop&Rev + Dynamic + Damp", stopAndReverse: true, dynamicTargets: true, aggression: 0.5 }
];

console.log(`Running continuous simulations (10,000 scenarios, 100 cycles/scenario) starting at $1000 USDT...`);
const results = configs.map(c => {
    console.log(`Simulating: ${c.name}...`);
    return runSimulation(c);
});
console.table(results);
fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/brain/72cccc12-7528-48ca-a7d2-3862d81002f0/artifacts/sim_results_continuous.json', JSON.stringify(results, null, 2));
console.log("Results saved.");
