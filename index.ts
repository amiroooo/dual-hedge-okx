/**
 * Dual-Hedged Futures Grid Skill
 * Framework: OpenClaw (2026)
 * Exchange: Binance Futures (Testnet)
 */

import { WebSocket } from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { createHmac } from 'crypto';

// --- OpenClaw Framework Abstractions (Mocked for compatibility) ---
// In a real environment, these would come from '@openclaw/sdk'
interface SkillConfig {
    symbol: string;
    marginPerBot: number;
    leverage: number;
    deltaPercent: number;
    gridLevels?: number;
}

interface LogService {
    info(msg: string): void;
    error(msg: string): void;
    warn(msg: string): void;
}

// --- Binance Testnet Config ---
const BINANCE_TESTNET_REST = 'https://testnet.binance.vision';
const BINANCE_TESTNET_FUTURUES_REST = 'https://testnet.binancefuture.com';
const BINANCE_TESTNET_WS_MARKET = 'wss://stream.binancefuture.com/ws/market'; // 'wss://testnet.binance.vision/ws';
// Note: Private WS usually requires a listenKey. For this 2026 arch spec, 
// we assume a direct authenticated channel or a managed tunnel via /private
const BINANCE_TESTNET_WS_PRIVATE = 'wss://stream.binancefuture.com/ws/private'; 

class DualHedgedGridSkill extends EventEmitter {
    private config: SkillConfig;
    private logger: LogService;
    private marketWs?: WebSocket;
    private privateWs?: WebSocket;
    
    // Strategy State
    private currentPrice: number = 0;
    private lowerBound: number = 0;
    private upperBound: number = 0;
    private isRunning: boolean = false;
    private killSwitchTriggered: boolean = false;

    // Order Tracking
    private longOrderIds: string[] = [];
    private shortOrderIds: string[] = [];

    constructor(config: SkillConfig, logger: LogService) {
        super();
        this.config = config;
        this.logger = logger;
    }

    /**
     * Initialize the Skill
     */
    public async start(): Promise<void> {
        this.logger.info(`Initializing Dual-Hedged Grid for ${this.config.symbol}`);
        
        try {
            // 1. Set Leverage & Margin Mode
            await this.configureFuturesAccount();

            // 2. Get Initial Price to Calculate Range
            this.currentPrice = await this.fetchMarkPrice();
            this.calculateRange();

            // 3. Connect WebSockets (2026 Arch)
            await this.connectWebSockets();

            // 4. Deploy Grids
            await this.deployGrids();

            this.isRunning = true;
            this.logger.info('Dual-Hedged Grid Active. Kill Switch Armed.');
        } catch (error) {
            this.logger.error('error: ', error.response.data);
            await this.executeAtomicClose();
        }
    }

    /**
     * Calculate Price Range based on deltaPercent
     */
    private calculateRange(): void {
        const delta = this.config.deltaPercent;
        this.lowerBound = this.currentPrice * (1 - delta);
        this.upperBound = this.currentPrice * (1 + delta);
        this.logger.info(`Range Set: [${this.lowerBound.toFixed(2)}, ${this.upperBound.toFixed(2)}]`);
    }

    /**
     * Configure Binance Futures Account (Testnet)
     */
    private async configureFuturesAccount(): Promise<void> {
        // Set Margin Mode to ISOLATED for safety per bot logic
        await this.signSpotRequest('POST', '/fapi/v1/marginType', {
            symbol: this.config.symbol,
            marginType: 'ISOLATED'
        });

        // Set Leverage
        await this.signSpotRequest('POST', '/fapi/v1/leverage', {
            symbol: this.config.symbol,
            leverage: this.config.leverage
        });
    }

    /**
     * Connect to 2026 WebSocket Architecture
     */
    private async connectWebSockets(): Promise<void> {
        // 1. Market Data Stream (/market)
        this.marketWs = new WebSocket(`${BINANCE_TESTNET_WS_MARKET}/${this.config.symbol.toLowerCase()}@markPrice`);
        
        this.marketWs.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.p) {
                this.handleMarkPriceUpdate(parseFloat(msg.p));
            }
        });

        // 2. Private Strategy Stream (/private)
        // In a real 2026 arch, this might be a managed connection by OpenClaw
        this.privateWs = new WebSocket(`${BINANCE_TESTNET_WS_PRIVATE}`);
        
        this.privateWs.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            this.handleStrategyUpdate(msg);
        });

        this.marketWs.on('error', (err) => this.logger.error(`Market WS Error: ${err}`));
        this.privateWs.on('error', (err) => this.logger.error(`Private WS Error: ${err}`));
    }

    /**
     * Handle Mark Price Updates (Kill Switch Logic Part 1)
     */
    private handleMarkPriceUpdate(price: number): void {
        this.currentPrice = price;

        // Check Range Breach
        if (price < this.lowerBound || price > this.upperBound) {
            this.logger.warn(`MARK PRICE BREACH DETECTED: ${price}`);
            this.triggerKillSwitch('Price Range Breach');
        }
    }

    /**
     * Handle Strategy Updates (Kill Switch Logic Part 2)
     */
    private handleStrategyUpdate(event: any): void {
        // Expecting event type: STRATEGY_UPDATE
        if (event.type === 'STRATEGY_UPDATE') {
            const { status, side } = event.payload;
            
            // If one bot stops or errors, kill the twin
            if (status === 'STOPPED' || status === 'ERROR' || status === 'FILLED_EDGE') {
                this.logger.warn(`STRATEGY UPDATE RECEIVED: ${side} is ${status}`);
                this.triggerKillSwitch(`Twin Bot Status: ${status}`);
            }
        }
    }

    /**
     * Deploy Long and Short Grids
     */
    private async deployGrids(): Promise<void> {
        const levels = this.config.gridLevels || 10;
        const step = (this.upperBound - this.lowerBound) / levels;

        this.logger.info('Deploying LONG Grid...');
        // Long Grid: Buy Low, Sell High
        for (let i = 0; i < levels; i++) {
            const price = this.lowerBound + (step * i);
            // Place Limit Buy
            const orderId = await this.placeOrder('BUY', price);
            if(orderId) this.longOrderIds.push(orderId);
        }

        this.logger.info('Deploying SHORT Grid...');
        // Short Grid: Sell High, Buy Low
        for (let i = 0; i < levels; i++) {
            const price = this.upperBound - (step * i);
            // Place Limit Sell
            const orderId = await this.placeOrder('SELL', price);
            if(orderId) this.shortOrderIds.push(orderId);
        }
    }

    /**
     * Place a Futures Order
     */
    private async placeOrder(side: 'BUY' | 'SELL', price: number): Promise<string | null> {
        try {
            // Calculate quantity based on marginPerBot / levels / leverage
            // Simplified for example
            const notionalValue = this.config.marginPerBot / this.config.leverage; 
            const qty = (notionalValue / price).toFixed(3); // Adjust precision logic per symbol

            const params = {
                symbol: this.config.symbol,
                side: side,
                type: 'LIMIT',
                price: price.toFixed(2),
                quantity: qty,
                timeInForce: 'GTC'
            };

            const response = await this.signRequest('POST', '/fapi/v1/order', params);
            return response.orderId.toString();
        } catch (e) {
            this.logger.error(`Order Placement Failed: ${e}`);
            return null;
        }
    }

    /**
     * TRIGGER: Atomic Close (Kill Switch)
     * Cancels all orders and closes all positions immediately.
     */
    private async triggerKillSwitch(reason: string): Promise<void> {
        if (this.killSwitchTriggered) return; // Prevent re-entry
        this.killSwitchTriggered = true;
        this.isRunning = false;

        this.logger.error(`!!! KILL SWITCH TRIGGERED: ${reason} !!!`);
        await this.executeAtomicClose();
        this.emit('SKILL_TERMINATED', { reason, timestamp: Date.now() });
    }

    /**
     * Execute Atomic Close Logic
     */
    private async executeAtomicClose(): Promise<void> {
        this.logger.info('Executing Atomic Close Sequence...');

        try {
            // 1. Cancel All Open Orders (Both Sides)
            await Promise.all([
                this.cancelAllOrders(),
                // In a real scenario, we might need to cancel specific IDs if bulk cancel isn't available
            ]);

            // 2. Close All Positions (Market Orders to flatten)
            // We need to check position side to know whether to BUY or SELL to close
            await this.closeAllPositions();

            this.logger.info('Atomic Close Complete. Account Flattened.');
        } catch (error) {
            this.logger.error(`Atomic Close Failed partially: ${error}`);
            // In a critical failure, we might retry or alert an admin
        } finally {
            this.cleanupWebSockets();
        }
    }

    private async cancelAllOrders(): Promise<void> {
        await this.signRequest('DELETE', '/fapi/v1/allOpenOrders', {
            symbol: this.config.symbol
        });
        this.longOrderIds = [];
        this.shortOrderIds = [];
    }

    private async closeAllPositions(): Promise<void> {
        // Fetch position risk to determine direction
        const positionData = await this.signRequest('GET', '/fapi/v2/positionRisk', { symbol: this.config.symbol });
        
        // Binance returns array, usually [0] is Long, [1] is Short or based on side
        for (const pos of positionData) {
            const posAmt = parseFloat(pos.positionAmt);
            if (posAmt !== 0) {
                const sideToClose = posAmt > 0 ? 'SELL' : 'BUY';
                const qty = Math.abs(posAmt).toString();
                
                this.logger.info(`Closing Position: ${sideToClose} ${qty}`);
                
                // Place Market Order to close
                await this.signRequest('POST', '/fapi/v1/order', {
                    symbol: this.config.symbol,
                    side: sideToClose,
                    type: 'MARKET',
                    quantity: qty,
                    reduceOnly: true // Crucial for closing without opening opposite
                });
            }
        }
    }

    private cleanupWebSockets(): void {
        if (this.marketWs) this.marketWs.close();
        if (this.privateWs) this.privateWs.close();
    }

    /**
     * Helper: Sign Binance Request (HMAC SHA256)
     * Requires API Key/Secret in env
     */
    private async signRequest(method: string, endpoint: string, params: any = {}) {
        const apiKey = process.env.BINANCE_API_KEY;
        const secret = process.env.BINANCE_API_SECRET;
        
        if (!apiKey || !secret) throw new Error('Missing API Credentials');

        params.timestamp = Date.now();
        const queryString = new URLSearchParams(params).toString();
        const signature = createHmac('sha256', secret).update(queryString).digest('hex');

        const url = `${BINANCE_TESTNET_FUTURUES_REST}${endpoint}?${queryString}&signature=${signature}`;

        const res = await axios({
            method,
            url,
            headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json' }
        });

        return res.data;
    }

    private async signSpotRequest(method: string, endpoint: string, params: any = {}) {
      const apiKey = process.env.BINANCE_API_KEY;
      const secret = process.env.BINANCE_API_SECRET;
      
      if (!apiKey || !secret) throw new Error('Missing API Credentials');

      params.timestamp = Date.now();
      const queryString = new URLSearchParams(params).toString();
      const signature = createHmac('sha256', secret).update(queryString).digest('hex');

      const url = `${BINANCE_TESTNET_REST}${endpoint}?${queryString}&signature=${signature}`;

      const res = await axios({
          method,
          url,
          headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json' }
      });

      return res.data;
    }

    private async fetchMarkPrice(): Promise<number> {
        const res = await axios.get(`${BINANCE_TESTNET_FUTURUES_REST}/fapi/v1/premiumIndex?symbol=${this.config.symbol}`, { headers: {'Content-Type': 'application/json'}});
        return parseFloat(res.data.markPrice);
    }
}

// --- Export for OpenClaw Loader ---
export default DualHedgedGridSkill;