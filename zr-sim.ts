import * as fs from 'fs';

const TRIALS = 10000;
const INITIAL_PRICE = 10000;
const MAX_REVERSALS = 5;
const TICK_PCT = 0.002;

interface SimConfig {
    name: string;
    stopAndReverse: boolean;
    dynamicTargets: boolean;
    aggression: number;
}

function runSimulation(config: SimConfig) {
    let wins = 0;
    let losses = 0;
    let totalGrossSize = 0;
    let maxGrossSizeGlobal = 0;
    let maxNetSizeGlobal = 0;
    
    for (let i = 0; i < TRIALS; i++) {
        let price = INITIAL_PRICE;
        let direction = 1; 
        
        let TP_high = price * 1.01;
        let SL_low = price * 0.98;
        let revDown = price * (1 - 0.012); 
        // Important: the reversal string up should actually be closer to P0.
        // In the original hedge logic, next time it goes up the reversal is at P0.
        let revUp = price;                 
        
        let legs: {dir: number, entry: number, sz: number}[] = [];
        legs.push({dir: direction, entry: price, sz: 1}); 
        
        let targetPx = TP_high;
        let slPx = SL_low;
        let revPx = revDown;
        
        let maxGrossTrial = 1;
        let maxNetTrial = 1;
        let legCount = 1;
        let active = true;
        let realizedPnl = 0;
        
        let iter = 0;
        while (active && iter < 100000) {
            iter++;
            price = price * (1 + (Math.random() < 0.5 ? TICK_PCT : -TICK_PCT));
            
            let hitTarget = (direction === 1 && price >= targetPx) || (direction === -1 && price <= targetPx);
            
            let hitRev = false;
            if (legCount < MAX_REVERSALS) {
                hitRev = (direction === 1 && price <= revPx) || (direction === -1 && price >= revPx);
            }
            
            let hitSl = false;
            if (legCount >= MAX_REVERSALS) {
                hitSl = (direction === 1 && price <= slPx) || (direction === -1 && price >= slPx);
            }
            
            if (hitTarget) {
                wins++;
                active = false;
            } else if (hitSl) {
                losses++;
                active = false;
            } else if (hitRev) {
                direction = -direction;
                legCount++;
                
                let revPriceActual = direction === 1 ? revUp : revDown;
                if (config.dynamicTargets) {
                     revPriceActual = price; // Use actual touched price
                }
                
                if (config.stopAndReverse) {
                    for (let leg of legs) {
                        let pnl = leg.sz * leg.dir * (revPriceActual - leg.entry);
                        realizedPnl += pnl;
                    }
                    legs = []; 
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
                
                let unrealizedAtTarget = 0;
                for (let leg of legs) {
                    unrealizedAtTarget += leg.sz * leg.dir * (targetPx - leg.entry);
                }
                
                let netNeeded = 1.0 - realizedPnl - unrealizedAtTarget;
                let dist = Math.abs(targetPx - revPriceActual);
                let szNeeded = netNeeded / dist;
                
                if (legCount >= 3) {
                    szNeeded *= config.aggression; 
                }
                if (szNeeded < 0) szNeeded = 0; 
                if (szNeeded < 1) szNeeded = 1;
                
                legs.push({dir: direction, entry: revPriceActual, sz: szNeeded});
                
                let gross = legs.reduce((sum, l) => sum + l.sz, 0);
                if (gross > maxGrossTrial) maxGrossTrial = gross;
                
                let netObj = legs.reduce((acc, l) => {
                    if(l.dir===1) acc.long += l.sz; 
                    else acc.short += l.sz; 
                    return acc;
                }, {long:0, short:0});
                let net = Math.abs(netObj.long - netObj.short);
                if (net > maxNetTrial) maxNetTrial = net;
            }
        }
        
        if (iter >= 100000) { losses++; }
        
        if (maxGrossTrial > maxGrossSizeGlobal) maxGrossSizeGlobal = maxGrossTrial;
        if (maxNetTrial > maxNetSizeGlobal) maxNetSizeGlobal = maxNetTrial;
        totalGrossSize += maxGrossTrial;
    }
    
    return {
        "Strategy": config.name,
        "Win Rate (%)": parseFloat(((wins / TRIALS) * 100).toFixed(2)),
        "Loss Rate (%)": parseFloat(((losses / TRIALS) * 100).toFixed(2)),
        "Avg Max Size": parseFloat((totalGrossSize / TRIALS).toFixed(2)),
        "Peak Gross Size": parseFloat(maxGrossSizeGlobal.toFixed(2)),
        "Peak Net Size": parseFloat(maxNetSizeGlobal.toFixed(2))
    };
}

const configs: SimConfig[] = [
    { name: "1. Base Hedged", stopAndReverse: false, dynamicTargets: false, aggression: 1.0 },
    { name: "2. Stop-and-Reverse", stopAndReverse: true, dynamicTargets: false, aggression: 1.0 },
    { name: "3. Dynamic Targets", stopAndReverse: false, dynamicTargets: true, aggression: 1.0 },
    { name: "4. Aggression Dampening (50%)", stopAndReverse: false, dynamicTargets: false, aggression: 0.5 },
    { name: "5. Stop&Reverse + Dynamic", stopAndReverse: true, dynamicTargets: true, aggression: 1.0 },
    { name: "6. Stop&Reverse + Dynamic + Damp", stopAndReverse: true, dynamicTargets: true, aggression: 0.5 }
];

console.log(`Running simulations (${TRIALS} trials each)...`);
const results = configs.map(c => {
    console.log(`Simulating: ${c.name}...`);
    return runSimulation(c);
});
console.table(results);
fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/brain/72cccc12-7528-48ca-a7d2-3862d81002f0/artifacts/sim_results.json', JSON.stringify(results, null, 2));
console.log("Results saved to sim_results.json");
