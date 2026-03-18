export interface StrategyUpdateEvent {
  e: 'STRATEGY_UPDATE';
  E: number; // Event time
  strategyId: string;
  symbol: string;
  status: 'RUNNING' | 'STOPPED' | 'EXPIRED';
  side: 'LONG' | 'SHORT';
  reason?: string;
}

export interface MarkPriceEvent {
  e: 'markPriceUpdate';
  E: number;
  s: string; // Symbol
  p: string; // Mark price
  i: string; // Index price
  P: string; // Estimated settle price
  r: string; // Funding rate
  T: number; // Next funding time
}