import * as fs from 'fs';

const FILENAME = 'btc-1m-klines.csv';
const START_BALANCE = 500;
const LEVERAGE = 10;
const RANGE_PCT = 0.20;
const PROFIT_TARGET_PCT = 0.03;
const PROFIT_TARGET_ABS = 30;
const EXTRA_MARGIN_PCT = 0.30;
const GRID_NUM_BASE = 150;
const TAKER_FEE_PCT = 0.0006; // Weighted OKX taker
const MAKER_FEE_PCT = 0.0002; // Weighted OKX maker
const FUNDING_FEE_PCT = 0.00005;

function optimizeGridNum(notionalValue: number, minPx: number, maxPx: number) {
    const MIN_NET_PROFIT_USDT = 0.20;
    const FEE_FUDGE = 0.0012 * 2;
    let gridNum = 150;
    let expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
    let netProfitUsdt = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_FUDGE);
    while (gridNum > 3 && netProfitUsdt < MIN_NET_PROFIT_USDT) {
        gridNum -= 1;
        expectedProfitPerGrid = Math.pow(maxPx / minPx, 1 / gridNum) - 1;
        netProfitUsdt = (notionalValue / gridNum) * (expectedProfitPerGrid - FEE_FUDGE);
    }
    return { gridNum, netProfitUsdt };
}

class GridBot {
    direction: 'long' | 'short';
    minPx: number;
    maxPx: number;
    gridStep: number;
    szPerOrder: number; 
    deployPx: number;
    currentGridIdx: number;
    realizedPnl: number = 0;
    unrealizedPnl: number = 0;
    posSize: number = 0; 
    avgEntryPx: number = 0;
    makerFees: number = 0;
    takerFees: number = 0;
    
    constructor(dir: 'long' | 'short', entryPx: number, totalMargin: number, leverage: number, rangePct: number) {
        this.direction = dir;
        this.deployPx = entryPx;
        this.maxPx = entryPx * (1 + rangePct);
        this.minPx = entryPx * (1 - rangePct);
        
        const baseMargin = totalMargin * (1 - EXTRA_MARGIN_PCT);
        const { gridNum } = optimizeGridNum((baseMargin * (2/3)) * leverage, this.minPx, this.maxPx);

        this.gridStep = (this.maxPx - this.minPx) / gridNum;
        
        let notional = baseMargin * leverage;
        this.szPerOrder = notional / gridNum / entryPx; 
        
        let gridsInitial = 0;
        if (dir === 'long') {
            gridsInitial = Math.floor((this.maxPx - entryPx) / this.gridStep);
            this.posSize = gridsInitial * this.szPerOrder;
            this.avgEntryPx = entryPx;
        } else {
            gridsInitial = Math.floor((entryPx - this.minPx) / this.gridStep);
            this.posSize = - (gridsInitial * this.szPerOrder);
            this.avgEntryPx = entryPx;
        }
        this.takerFees += (Math.abs(this.posSize) * entryPx) * TAKER_FEE_PCT;
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
                    let newPos = this.posSize + this.szPerOrder;
                    this.avgEntryPx = ((this.avgEntryPx * this.posSize) + (fillPx * this.szPerOrder)) / newPos;
                    this.posSize = newPos;
                    this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                }
                this.currentGridIdx = minIdx;
            }
            else if (maxIdx > this.currentGridIdx) {
                let steps = maxIdx - this.currentGridIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx + i) * this.gridStep;
                    if(fillPx > this.maxPx) continue;
                    if (this.posSize >= this.szPerOrder) {
                        this.posSize -= this.szPerOrder;
                        this.realizedPnl += this.szPerOrder * (fillPx - this.avgEntryPx);
                        this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                    }
                }
                this.currentGridIdx = maxIdx;
            }
        } else {
            if (maxIdx > this.currentGridIdx) {
                let steps = maxIdx - this.currentGridIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx + i) * this.gridStep;
                    if(fillPx > this.maxPx) continue;
                    let currentAbsPos = Math.abs(this.posSize);
                    let newAbsPos = currentAbsPos + this.szPerOrder;
                    this.avgEntryPx = ((this.avgEntryPx * currentAbsPos) + (fillPx * this.szPerOrder)) / newAbsPos;
                    this.posSize = -newAbsPos;
                    this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                }
                this.currentGridIdx = maxIdx;
            }
            else if (minIdx < this.currentGridIdx) {
                let steps = this.currentGridIdx - minIdx;
                for(let i=1; i<=steps; i++) {
                    let fillPx = this.minPx + (this.currentGridIdx - i) * this.gridStep;
                    if(fillPx < this.minPx) continue;
                    if (Math.abs(this.posSize) >= this.szPerOrder) {
                        this.posSize += this.szPerOrder; 
                        this.realizedPnl += this.szPerOrder * (this.avgEntryPx - fillPx);
                        this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                    }
                }
                this.currentGridIdx = minIdx;
            }
        }
        this.unrealizedPnl = this.direction === 'long' ? this.posSize * (c - this.avgEntryPx) : Math.abs(this.posSize) * (this.avgEntryPx - c);
    }
    
    close(p: number) {
        this.takerFees += Math.abs(this.posSize) * p * TAKER_FEE_PCT;
        let pnl = this.direction === 'long' ? this.posSize * (p - this.avgEntryPx) : Math.abs(this.posSize) * (this.avgEntryPx - p);
        this.realizedPnl += pnl;
        this.posSize = 0;
        this.unrealizedPnl = 0;
    }
}

function run() {
    if (!fs.existsSync(FILENAME)) return console.log("CSV missing.");
    let lines = fs.readFileSync(FILENAME, 'utf-8').trim().split('\n');
    lines.shift();
    lines.reverse();
    
    let bankroll = START_BALANCE;
    let long: GridBot | null = null;
    let short: GridBot | null = null;
    let cycles = 0;
    let maxDD = 0;
    let cycleStartBalance = bankroll;

    for (let i=0; i<lines.length; i++) {
        let [ts, o, h, l, c] = lines[i].split(',').map(parseFloat);
        
        if (!long || !short) {
            let marginPerBot = bankroll / 2;
            long = new GridBot('long', o, marginPerBot, LEVERAGE, RANGE_PCT);
            short = new GridBot('short', o, marginPerBot, LEVERAGE, RANGE_PCT);
            cycleStartBalance = bankroll;
        }

        long.update(h, l, c);
        short.update(h, l, c);

        if (i % 480 === 0) { // Funding
            let cost = (Math.abs(long.posSize) * c + Math.abs(short.posSize) * c) * FUNDING_FEE_PCT;
            bankroll -= cost;
        }

        let equity = bankroll + (long.realizedPnl + long.unrealizedPnl - long.makerFees - long.takerFees)
                            + (short.realizedPnl + short.unrealizedPnl - short.makerFees - short.takerFees);
        
        let dd = ((cycleStartBalance - equity) / cycleStartBalance) * 100;
        if (dd > maxDD) maxDD = dd;
        if (equity <= 0) return console.log("LIQUIDATED at line", i);

        // V2 Termination logic
        let target = Math.max(PROFIT_TARGET_ABS, cycleStartBalance * PROFIT_TARGET_PCT);
        let netProfit = equity - cycleStartBalance;
        
        let boundaryUp = long.deployPx * (1 + RANGE_PCT);
        let boundaryDown = long.deployPx * (1 - RANGE_PCT);
        
        if (netProfit >= target || h >= boundaryUp || l <= boundaryDown) {
            long.close(c);
            short.close(c);
            bankroll += (long.realizedPnl - long.makerFees - long.takerFees) + (short.realizedPnl - short.makerFees - short.takerFees);
            cycles++;
            long = null; short = null;
        }
    }
    
    console.log(`\n=== DUAL-GRID V2 BACKTEST RESULTS ===`);
    console.log(`Start: $${START_BALANCE}`);
    console.log(`Final Equity: $${bankroll.toFixed(2)}`);
    console.log(`ROI: ${((bankroll / START_BALANCE - 1) * 100).toFixed(2)}%`);
    console.log(`Cycles: ${cycles}`);
    console.log(`Max DD: ${maxDD.toFixed(2)}%`);
}

run();
