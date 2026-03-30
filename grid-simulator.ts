import * as fs from 'fs';

const CONFIG_FILE = 'zr-config.json';
const START_USDT = 1000;

const GRID_NUM = 150;
const BUFFER_DISTANCE_PCT = 0.02; 
const TAKER_FEE_PCT = 0.0005;
const MAKER_FEE_PCT = 0.0002;
const FUNDING_FEE_PCT = 0.00005;

class GridBot {
    direction: 'long' | 'short';
    minPx: number;
    maxPx: number;
    gridStep: number;
    szPerOrder: number; 
    
    tp: number;
    sl: number;
    deployPx: number;
    
    currentGridIdx: number;
    realizedPnl: number = 0;
    unrealizedPnl: number = 0;
    totalActivePositionStr: number = 0; 
    avgEntryPx: number = 0;
    
    makerFeesPaid: number = 0;
    takerFeesPaid: number = 0;
    
    constructor(dir: 'long' | 'short', entryPx: number, marginUsdt: number, leverage: number, rangePct: number) {
        this.direction = dir;
        this.deployPx = entryPx;
        this.maxPx = entryPx * (1 + rangePct);
        this.minPx = entryPx * (1 - rangePct);
        this.gridStep = (this.maxPx - this.minPx) / GRID_NUM;
        
        let notional = marginUsdt * leverage;
        this.szPerOrder = notional / GRID_NUM / entryPx; 
        
        let buffer = (this.maxPx - this.minPx) * BUFFER_DISTANCE_PCT;
        
        if (dir === 'long') {
            this.sl = this.minPx - buffer;
            this.tp = this.maxPx + buffer;
            let gridsAbove = Math.floor((this.maxPx - entryPx) / this.gridStep);
            this.totalActivePositionStr = gridsAbove * this.szPerOrder;
            this.avgEntryPx = entryPx;
            this.takerFeesPaid += (this.totalActivePositionStr * entryPx) * TAKER_FEE_PCT; 
        } else {
            this.sl = this.maxPx + buffer;
            this.tp = this.minPx - buffer;
            let gridsBelow = Math.floor((entryPx - this.minPx) / this.gridStep);
            this.totalActivePositionStr = - (gridsBelow * this.szPerOrder);
            this.avgEntryPx = entryPx;
            this.takerFeesPaid += (Math.abs(this.totalActivePositionStr) * entryPx) * TAKER_FEE_PCT; 
        }
        
        this.currentGridIdx = Math.floor((entryPx - this.minPx) / this.gridStep);
    }
    
    update(h: number, l: number, c: number) {
        let minIdx = Math.floor((l - this.minPx) / this.gridStep);
        let maxIdx = Math.floor((h - this.minPx) / this.gridStep);
        
        if (this.direction === 'long') {
            if (minIdx < this.currentGridIdx) {
                let steps = this.currentGridIdx - minIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx - i) * this.gridStep;
                    if(fillPx < this.minPx) continue;
                    let newPos = this.totalActivePositionStr + this.szPerOrder;
                    this.avgEntryPx = ((this.avgEntryPx * this.totalActivePositionStr) + (fillPx * this.szPerOrder)) / newPos;
                    this.totalActivePositionStr = newPos;
                    this.makerFeesPaid += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                }
                this.currentGridIdx = minIdx;
            }
            else if (maxIdx > this.currentGridIdx) {
                let steps = maxIdx - this.currentGridIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx + i) * this.gridStep;
                    if(fillPx > this.maxPx) continue;
                    if (this.totalActivePositionStr >= this.szPerOrder) {
                        this.totalActivePositionStr -= this.szPerOrder;
                        this.realizedPnl += this.szPerOrder * (fillPx - this.avgEntryPx);
                        this.makerFeesPaid += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                    }
                }
                this.currentGridIdx = maxIdx;
            }
        } 
        else { 
            if (maxIdx > this.currentGridIdx) {
                let steps = maxIdx - this.currentGridIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx + i) * this.gridStep;
                    if(fillPx > this.maxPx) continue;
                    let currentAbsPos = Math.abs(this.totalActivePositionStr);
                    let newAbsPos = currentAbsPos + this.szPerOrder;
                    this.avgEntryPx = ((this.avgEntryPx * currentAbsPos) + (fillPx * this.szPerOrder)) / newAbsPos;
                    this.totalActivePositionStr = -newAbsPos;
                    this.makerFeesPaid += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                }
                this.currentGridIdx = maxIdx;
            }
            else if (minIdx < this.currentGridIdx) {
                let steps = this.currentGridIdx - minIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx - i) * this.gridStep;
                    if(fillPx < this.minPx) continue;
                    if (Math.abs(this.totalActivePositionStr) >= this.szPerOrder) {
                        this.totalActivePositionStr += this.szPerOrder; 
                        this.realizedPnl += this.szPerOrder * (this.avgEntryPx - fillPx);
                        this.makerFeesPaid += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                    }
                }
                this.currentGridIdx = minIdx;
            }
        }
        
        if (this.direction === 'long') {
            this.unrealizedPnl = this.totalActivePositionStr * (c - this.avgEntryPx);
        } else {
            this.unrealizedPnl = Math.abs(this.totalActivePositionStr) * (this.avgEntryPx - c);
        }
    }
    
    closeMarket(exitPx: number) {
        let closingFee = Math.abs(this.totalActivePositionStr) * exitPx * TAKER_FEE_PCT;
        this.takerFeesPaid += closingFee;
        let closePnl = 0;
        if (this.direction === 'long') {
            closePnl = this.totalActivePositionStr * (exitPx - this.avgEntryPx);
        } else {
            closePnl = Math.abs(this.totalActivePositionStr) * (this.avgEntryPx - exitPx);
        }
        this.realizedPnl += closePnl;
        this.totalActivePositionStr = 0;
        this.unrealizedPnl = 0;
    }
}

function runSimulationForPair(sym: string, lev: number, rangePct: number, profitTargetPct: number) {
    const filename = `${sym.toLowerCase()}-1m-klines.csv`;
    if (!fs.existsSync(filename)) {
        return { name: sym, surv: false, finalUSDT: 0, dd: 0, cycles: 0, msg: 'No Data' };
    }
    
    let fileStr = fs.readFileSync(filename, 'utf-8').trim();
    let lines = fileStr.split('\n');
    lines.shift();
    lines.reverse();
    
    let balance = START_USDT;
    let longBot: GridBot | null = null;
    let shortBot: GridBot | null = null;
    
    let cyclesCompleted = 0;
    let survived = true;
    let maxGlobalDrawdown = 0;
    let cycleStartBalance = balance;
    
    for (let i = 0; i < lines.length; i++) {
        if (!survived) break;
        let cols = lines[i].split(',');
        if (cols.length < 5) continue;
        let o = parseFloat(cols[1]), h = parseFloat(cols[2]), l = parseFloat(cols[3]), c = parseFloat(cols[4]);
        
        if (!longBot || !shortBot) {
            let marginPerBot = balance / 2;
            longBot = new GridBot('long', o, marginPerBot, lev, rangePct);
            shortBot = new GridBot('short', o, marginPerBot, lev, rangePct);
            cycleStartBalance = balance;
        }
        
        longBot.update(h, l, c);
        shortBot.update(h, l, c);
        
        let equity = balance + longBot.realizedPnl + longBot.unrealizedPnl - longBot.makerFeesPaid - longBot.takerFeesPaid
                           + shortBot.realizedPnl + shortBot.unrealizedPnl - shortBot.makerFeesPaid - shortBot.takerFeesPaid;
                           
        if (i > 0 && i % 480 === 0) {
            let fundingCostUSDT = (Math.abs(longBot.totalActivePositionStr) * c + Math.abs(shortBot.totalActivePositionStr) * c) * FUNDING_FEE_PCT;
            equity -= fundingCostUSDT;
            balance -= fundingCostUSDT;
        }
        
        let drawdown = ((cycleStartBalance - equity) / cycleStartBalance) * 100;
        if (drawdown > maxGlobalDrawdown) maxGlobalDrawdown = drawdown;
        
        if (equity <= 0) { survived = false; break; }
        
        // Slippage & Terminations
        let terminate = false;
        let longExitPx = c; 
        let shortExitPx = c;
        
        // 1. Absolute Profit Target condition ($30 USDT equivalent on $1000 start)
        let targetProfitUsdt = cycleStartBalance * profitTargetPct;
        let cycleNetPnl = equity - cycleStartBalance;
        
        if (cycleNetPnl >= targetProfitUsdt) {
            terminate = true;
            longExitPx = c; // Market close at exact current candle price
            shortExitPx = c; 
        } 
        else {
            // 2. Normal Boundary SL / Breakout logic
            let upsideTrigger = longBot.deployPx * (1 + rangePct);
            let downsideTrigger = longBot.deployPx * (1 - rangePct);
            
            if (h >= upsideTrigger) { 
                terminate = true; 
                longExitPx = upsideTrigger; 
                shortExitPx = h > upsideTrigger ? h : upsideTrigger; 
            }
            else if (l <= downsideTrigger) { 
                terminate = true; 
                longExitPx = l < downsideTrigger ? l : downsideTrigger; 
                shortExitPx = downsideTrigger; 
            }
        }
        
        if (terminate) {

            
            longBot.closeMarket(longExitPx);
            shortBot.closeMarket(shortExitPx);
            
            balance += longBot.realizedPnl - longBot.makerFeesPaid - longBot.takerFeesPaid;
            balance += shortBot.realizedPnl - shortBot.makerFeesPaid - shortBot.takerFeesPaid;
            cyclesCompleted++;
            
            longBot = null;
            shortBot = null;
        }
    }
    
    let equityFinal = survived && longBot && shortBot 
        ? balance + longBot.realizedPnl + longBot.unrealizedPnl - longBot.makerFeesPaid - longBot.takerFeesPaid
          + shortBot.realizedPnl + shortBot.unrealizedPnl - shortBot.makerFeesPaid - shortBot.takerFeesPaid
        : 0;
    
    return { name: sym, lev, surv: survived, finalUSDT: equityFinal, dd: maxGlobalDrawdown, cycles: cyclesCompleted, msg: 'Success' };
}

function runBatchAllPairs() {
    let configStr = fs.readFileSync(CONFIG_FILE, 'utf-8');
    let config = JSON.parse(configStr);
    
    console.log(`\n=== EARLY TERMINATION DUAL GRID BATCH TEST ===`);
    let targets = [0.01, 0.03, 0.05, 0.10]; // 1%, 3% ($30), 5%, 10% target per cycle
    let rangeToTest = 0.20; 
    
    for (let p of config.pairs) {
        let sym = p.instId;
        
        let lev = sym === 'BTC-USDT-SWAP' ? 10 : 5; // Use 10x for BTC, 5x for Alts
        
        console.log(`\n--- ${sym} (Lev: ${lev}x | Range: 20%) ---`);
        for (let t of targets) {
            let res = runSimulationForPair(sym, lev, rangeToTest, t);
            if (res.msg !== 'Success') {
                console.log(` [Close at +${t*100}% Profit] Error: ${res.msg}`);
            } else {
                console.log(` [Close at +${t*100}% Profit] Surv: ${res.surv ? 'YES' : 'NO '} | End: $${res.finalUSDT.toFixed(2)} | Peak DD: ${res.dd.toFixed(2)}% | Cycles: ${res.cycles}`);
            }
        }
    }
}

runBatchAllPairs();
