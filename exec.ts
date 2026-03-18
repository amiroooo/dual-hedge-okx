import DualHedgedGridSkill from './index.ts';
const bot = new DualHedgedGridSkill({
    symbol: 'BTCUSDT',
    marginPerBot: 100,
    leverage: 5,
    deltaPercent: 0.05
}, console);
bot.start();