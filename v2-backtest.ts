import * as fs from 'fs';

const CONFIG_FILE = './v2-config.json';
const START_BALANCE = 500;

function loadV2Config() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))['BTC-USDT-SWAP'];
}

const liveCfg = loadV2Config();
const RANGE_PCT = liveCfg.rangePct || 0.20;
const PROFIT_TARGET_PCT = liveCfg.profitTargetPct || 0.03;
const EXTRA_MARGIN_PCT = liveCfg.extraMarginPct || 0.30;
const TAKER_FEE_PCT = 0.0006;
const MAKER_FEE_PCT = 0.0002;
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
    gridCloses: number = 0;
    gridStates: { [idx: number]: { openPx: number, openTs: number } } = {};
    auditLog: string[] = [];

    constructor(dir: 'long' | 'short', entryPx: number, totalMargin: number, leverage: number, rangePct: number) {
        this.direction = dir;
        this.deployPx = entryPx;
        this.maxPx = entryPx * (1 + rangePct);
        this.minPx = entryPx * (1 - rangePct);

        const baseMargin = totalMargin * (1 - EXTRA_MARGIN_PCT);
        const { gridNum } = optimizeGridNum((baseMargin * (2 / 3)) * leverage, this.minPx, this.maxPx);

        this.gridStep = (this.maxPx - this.minPx) / gridNum;
        let notional = (baseMargin * (2 / 3)) * leverage;
        this.szPerOrder = notional / gridNum / entryPx;

        let gridsInitial = 0;
        if (dir === 'long') {
            gridsInitial = Math.floor((this.maxPx - entryPx) / this.gridStep);
            this.posSize = gridsInitial * this.szPerOrder;
            this.avgEntryPx = entryPx;
            // Mark initial slots as held
            for (let i = 0; i < gridsInitial; i++) {
                const idx = Math.floor((entryPx - this.minPx) / this.gridStep) + i + 1;
                this.gridStates[idx] = { openPx: entryPx, openTs: 0 };
            }
        } else {
            gridsInitial = Math.floor((entryPx - this.minPx) / this.gridStep);
            this.posSize = - (gridsInitial * this.szPerOrder);
            this.avgEntryPx = entryPx;
            for (let i = 0; i < gridsInitial; i++) {
                const idx = Math.floor((entryPx - this.minPx) / this.gridStep) - i - 1;
                this.gridStates[idx] = { openPx: entryPx, openTs: 0 };
            }
        }
        this.takerFees += (Math.abs(this.posSize) * entryPx) * TAKER_FEE_PCT;
        this.currentGridIdx = Math.floor((entryPx - this.minPx) / this.gridStep);
    }

    update(h: number, l: number, c: number, o: number) {
        const moves = c >= o ? [{ low: l, high: l }, { low: h, high: h }] : [{ low: h, high: h }, { low: l, high: l }];
        for (const move of moves) {
            let minIdx = Math.floor((move.low - this.minPx) / this.gridStep);
            let maxIdx = Math.floor((move.high - this.minPx) / this.gridStep);

            if (this.direction === 'long') {
                if (minIdx < this.currentGridIdx) { // Buying
                    let steps = this.currentGridIdx - minIdx;
                    for (let i = 1; i <= steps; i++) {
                        let idx = this.currentGridIdx - i;
                        let fillPx = this.minPx + idx * this.gridStep;
                        if (fillPx < this.minPx || fillPx > this.maxPx) continue;
                        if (!this.gridStates[idx]) {
                            let newPos = this.posSize + this.szPerOrder;
                            this.avgEntryPx = ((this.avgEntryPx * this.posSize) + (fillPx * this.szPerOrder)) / newPos;
                            this.posSize = newPos;
                            this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                            this.logFill(idx, 'open', fillPx, move.low);
                        }
                    }
                    this.currentGridIdx = Math.max(0, minIdx);
                }
                if (maxIdx > this.currentGridIdx) { // Selling
                    let steps = maxIdx - this.currentGridIdx;
                    for (let i = 1; i <= steps; i++) {
                        let idx = this.currentGridIdx + i;
                        let fillPx = this.minPx + idx * this.gridStep;
                        if (fillPx > this.maxPx || fillPx < this.minPx) continue;
                        if (this.gridStates[idx]) {
                            this.posSize -= this.szPerOrder;
                            this.realizedPnl += this.szPerOrder * (fillPx - this.avgEntryPx);
                            this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                            this.gridCloses++;
                            this.logFill(idx, 'close', fillPx, move.high);
                        }
                    }
                    this.currentGridIdx = maxIdx;
                }
            } else { // Short direction
                if (maxIdx > this.currentGridIdx) { // Opening Short
                    let steps = maxIdx - this.currentGridIdx;
                    for (let i = 1; i <= steps; i++) {
                        let idx = this.currentGridIdx + i;
                        let fillPx = this.minPx + idx * this.gridStep;
                        if (fillPx > this.maxPx || fillPx < this.minPx) continue;
                        if (!this.gridStates[idx]) {
                            let currentAbsPos = Math.abs(this.posSize);
                            let newAbsPos = currentAbsPos + this.szPerOrder;
                            this.avgEntryPx = ((this.avgEntryPx * currentAbsPos) + (fillPx * this.szPerOrder)) / newAbsPos;
                            this.posSize = -newAbsPos;
                            this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                            this.logFill(idx, 'open', fillPx, move.high);
                        }
                    }
                    this.currentGridIdx = maxIdx;
                }
                if (minIdx < this.currentGridIdx) { // Closing Short
                    let steps = this.currentGridIdx - minIdx;
                    for (let i = 1; i <= steps; i++) {
                        let idx = this.currentGridIdx - i;
                        let fillPx = this.minPx + idx * this.gridStep;
                        if (fillPx < this.minPx || fillPx > this.maxPx) continue;
                        if (this.gridStates[idx]) {
                            this.posSize += this.szPerOrder;
                            this.realizedPnl += this.szPerOrder * (this.avgEntryPx - fillPx);
                            this.makerFees += (this.szPerOrder * fillPx) * MAKER_FEE_PCT;
                            this.gridCloses++;
                            this.logFill(idx, 'close', fillPx, move.low);
                        }
                    }
                    this.currentGridIdx = Math.max(0, minIdx);
                }
            }
        }
        this.unrealizedPnl = this.direction === 'long' ? this.posSize * (c - this.avgEntryPx) : Math.abs(this.posSize) * (this.avgEntryPx - c);
    }

    logFill(idx: number, action: 'open' | 'close', px: number, ts: number) {
        if (action === 'open') {
            this.gridStates[idx] = { openPx: px, openTs: ts };
        } else {
            delete this.gridStates[idx];
        }
        this.auditLog.push(`${ts},${this.direction},${idx},${action},${px.toFixed(2)}`);
    }

    close(p: number) {
        this.takerFees += Math.abs(this.posSize) * p * TAKER_FEE_PCT;
        let pnl = this.direction === 'long' ? this.posSize * (p - this.avgEntryPx) : Math.abs(this.posSize) * (this.avgEntryPx - p);
        this.realizedPnl += pnl;
        this.posSize = 0;
        this.unrealizedPnl = 0;
        this.gridStates = {};
    }
}


function runSim(targetAbs: number, leverage: number, filename: string) {
    if (!fs.existsSync(filename)) { console.log(`File not found: ${filename}`); return null; }
    let lines = fs.readFileSync(filename, 'utf-8').trim().split('\n');
    lines.shift();
    lines.reverse();

    let bankroll = START_BALANCE;
    let long: GridBot | null = null;
    let short: GridBot | null = null;
    let cycles = 0;
    let maxDD = 0;
    let cycleStartBalance = bankroll;
    let totalGridProfit = 0;
    let totalGridCloses = 0;
    let allAuditLogs: string[] = [];

    let firstGridNum = 0;
    let lastGridNum = 0;
    let minCycleProfit = Infinity;
    let cycleReached150 = -1;

    const startTs = parseFloat(lines[0].split(',')[0]);
    const endTs = parseFloat(lines[lines.length - 1].split(',')[0]);
    const durationDays = (endTs - startTs) / (1000 * 60 * 60 * 24);

    for (let i = 0; i < lines.length; i++) {
        let cols = lines[i].split(',');
        if (cols.length < 5) continue;
        let [ts, o, h, l, c] = cols.map(parseFloat);

        if (!long || !short) {
            const baseMargin = (bankroll / 2) * (1 - EXTRA_MARGIN_PCT);
            const { gridNum } = optimizeGridNum((baseMargin * (2 / 3)) * leverage, o * (1 - RANGE_PCT), o * (1 + RANGE_PCT));
            if (firstGridNum === 0) firstGridNum = gridNum;
            lastGridNum = gridNum;

            if (gridNum >= 150 && cycleReached150 === -1) {
                cycleReached150 = cycles;
            }

            long = new GridBot('long', o, bankroll / 2, leverage, RANGE_PCT);
            short = new GridBot('short', o, bankroll / 2, leverage, RANGE_PCT);
            cycleStartBalance = bankroll;
        }

        long.update(h, l, c, o);
        short.update(h, l, c, o);

        if (i % 480 === 0) {
            // Funding on gross exposure:
            bankroll -= (Math.abs(long.posSize) * c + Math.abs(short.posSize) * c) * FUNDING_FEE_PCT;
        }

        let equity = bankroll + (long.realizedPnl + long.unrealizedPnl - long.makerFees - long.takerFees)
            + (short.realizedPnl + short.unrealizedPnl - short.makerFees - short.takerFees);

        let dd = ((cycleStartBalance - equity) / cycleStartBalance) * 100;
        if (dd > maxDD) maxDD = dd;
        if (equity <= 0) return { targetAbs, final: 0, dd: 100, cycles, survived: false, durationDays, totalGridCloses, totalGridProfit, firstGridNum, lastGridNum, leverage, minCycleProfit: -cycleStartBalance, cycleReached150: -1 };

        let target = Math.max(targetAbs, cycleStartBalance * PROFIT_TARGET_PCT);
        let netProfit = equity - cycleStartBalance;
        let boundaryUp = long.deployPx * (1 + RANGE_PCT);
        let boundaryDown = long.deployPx * (1 - RANGE_PCT);

        if (netProfit >= target || h >= boundaryUp || l <= boundaryDown) {
            // Pre-capture profit for gridCloses incrementing correctly
            allAuditLogs.push(...long.auditLog);
            allAuditLogs.push(...short.auditLog);

            long.close(c);
            short.close(c);

            const actualCycleProfit = (long.realizedPnl - long.makerFees - long.takerFees) + (short.realizedPnl - short.makerFees - short.takerFees);
            if (actualCycleProfit < minCycleProfit) minCycleProfit = actualCycleProfit;

            bankroll += actualCycleProfit;
            totalGridProfit += actualCycleProfit;
            totalGridCloses += long.gridCloses + short.gridCloses;
            cycles++;
            long = null; short = null;
        }
    }

    if (long && short) {
        const finalPx = parseFloat(lines[lines.length - 1].split(',')[4]);
        long.close(finalPx);
        short.close(finalPx);
        allAuditLogs.push(...long.auditLog);
        allAuditLogs.push(...short.auditLog);
        const lastCycleProfit = (long.realizedPnl - long.makerFees - long.takerFees) + (short.realizedPnl - short.makerFees - short.takerFees);
        if (lastCycleProfit < minCycleProfit) minCycleProfit = lastCycleProfit;
        bankroll += lastCycleProfit;
        totalGridProfit += lastCycleProfit;
        totalGridCloses += long.gridCloses + short.gridCloses;
    }

    if (targetAbs === 50 && leverage === 10 && filename.includes('btc')) {
        const header = "Timestamp,Bot,SlotIdx,Action,Price\n";
        const log = allAuditLogs.slice(0, 500).join("\n");
        fs.writeFileSync("audit_first_day.csv", header + log);
    }

    return { targetAbs, final: bankroll, dd: maxDD, cycles, survived: true, durationDays, totalGridCloses, totalGridProfit, firstGridNum, lastGridNum, leverage, minCycleProfit, cycleReached150 };
}

function main() {
    console.log(`\n=== DUAL-GRID V2 PORTFOLIO AUDIT ===`);
    console.log(`Config: Start $${START_BALANCE} | Range ${RANGE_PCT * 100}% | Padding ${EXTRA_MARGIN_PCT * 100}%`);

    const assets = [
        { name: "BTC", file: "btc-1m-klines.csv" },
        { name: "ETH", file: "eth-usdt-swap-1m-klines.csv" },
        { name: "SOL", file: "sol-usdt-swap-1m-klines.csv" }
    ];

    const results: any[] = [];

    assets.forEach(asset => {
        [3, 5, 10, 20].forEach(lev => {
            [10, 50].forEach(t => {
                const res = runSim(t, lev, asset.file);
                if (!res) return;
                const profitUsdt = res.final - START_BALANCE;
                const roiTotal = (res.final / START_BALANCE - 1) * 100;
                const roiPerYear = roiTotal / (res.durationDays / 365);
                const avgClosesDay = res.totalGridCloses / res.durationDays;
                const avgGridProfit = res.totalGridCloses > 0 ? res.totalGridProfit / res.totalGridCloses : 0;

                let daysTo2x = "Inf";
                if (profitUsdt > 0) {
                    const dailyProfit = profitUsdt / res.durationDays;
                    daysTo2x = (START_BALANCE / dailyProfit).toFixed(1);
                }

                results.push({
                    asset: asset.name,
                    lev: `${lev}x`,
                    target: `$${t}`,
                    profit: `$${profitUsdt.toFixed(2)}`,
                    roi: `${roiTotal.toFixed(1)}%`,
                    yearly: `${roiPerYear.toFixed(0)}%`,
                    dd: `${res.dd.toFixed(1)}%`,
                    closes: avgClosesDay.toFixed(1),
                    to2x: daysTo2x,
                    minCycle: `$${res.minCycleProfit.toFixed(2)}`,
                    avgGrid: `$${avgGridProfit.toFixed(2)}`,
                    scale150: res.cycleReached150 === -1 ? "N/A" : res.cycleReached150.toString()
                });
            });
        });
    });

    const pad = (s: string, n: number) => s.padEnd(n);

    console.log(`\n| ${pad("Asset", 5)} | ${pad("Lev", 5)} | ${pad("Target", 8)} | ${pad("Profit USDT", 12)} | ${pad("ROI %", 7)} | ${pad("Year %", 7)} | ${pad("Max DD %", 8)} | ${pad("Clos/D", 6)} | ${pad("2x Days", 7)} | ${pad("Worst Cy", 9)} | ${pad("Avg/Grid", 8)} | ${pad("150G Cy", 7)} |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    results.forEach(r => {
        console.log(`| ${pad(r.asset, 5)} | ${pad(r.lev, 5)} | ${pad(r.target, 8)} | ${pad(r.profit, 12)} | ${pad(r.roi, 7)} | ${pad(r.yearly, 7)} | ${pad(r.dd, 8)} | ${pad(r.closes, 6)} | ${pad(r.to2x, 7)} | ${pad(r.minCycle, 9)} | ${pad(r.avgGrid, 8)} | ${pad(r.scale150, 7)} |`);
    });
}


main();




