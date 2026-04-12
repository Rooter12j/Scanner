// api/trade.js — Vercel Serverless Function
// All Binance API calls are made here, server-side.
// API keys come from Vercel environment variables:
//   BINANCE_API_KEY
//   BINANCE_API_SECRET
// Set these in: Vercel Dashboard → Project → Settings → Environment Variables

const crypto = require('crypto');

function sign(secret, query) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function binance(endpoint, params = {}, method = 'GET') {
  const KEY    = process.env.BINANCE_API_KEY;
  const SECRET = process.env.BINANCE_API_SECRET;

  if (!KEY || !SECRET) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set in Vercel env vars');
  }

  params.timestamp  = Date.now();
  params.recvWindow = 5000;
  const qs  = new URLSearchParams(params).toString();
  const sig = sign(SECRET, qs);
  const url = `https://fapi.binance.com${endpoint}?${qs}&signature=${sig}`;

  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': KEY },
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(data.msg || `Binance error ${data.code}`);
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ── GET /api/trade?action=account ─────────────────────────────────────
    if (req.method === 'GET' && action === 'account') {
      const data = await binance('/fapi/v2/account', {}, 'GET');
      return res.status(200).json({
        ok: true,
        balance: parseFloat(data.totalWalletBalance || 0),
        unrealizedPnl: parseFloat(data.totalUnrealizedProfit || 0),
        positions: (data.positions || [])
          .filter(p => parseFloat(p.positionAmt) !== 0)
          .map(p => ({
            symbol:      p.symbol,
            side:        parseFloat(p.positionAmt) > 0 ? 'long' : 'short',
            size:        Math.abs(parseFloat(p.positionAmt)),
            entryPrice:  parseFloat(p.entryPrice),
            pnl:         parseFloat(p.unrealizedProfit),
            leverage:    parseFloat(p.leverage),
            margin:      parseFloat(p.isolatedMargin || p.initialMargin),
          })),
      });
    }

    // ── POST /api/trade?action=order ──────────────────────────────────────
    if (req.method === 'POST' && action === 'order') {
      const { symbol, side, type, quantity, price, stopPrice,
              leverage, marginType, takeProfitPrice, stopLossPrice } = req.body;

      if (!symbol || !side || !quantity) {
        return res.status(400).json({ ok: false, error: 'Missing required fields' });
      }

      // 1. Set leverage
      try {
        await binance('/fapi/v1/leverage', { symbol, leverage: leverage || 10 });
      } catch (e) { /* already set */ }

      // 2. Set margin type
      try {
        await binance('/fapi/v1/marginType', { symbol, marginType: (marginType || 'CROSS').toUpperCase() });
      } catch (e) { /* already set */ }

      // 3. Place main order
      const orderParams = { symbol, side: side.toUpperCase(), type: (type || 'MARKET').toUpperCase(), quantity };
      if (type === 'LIMIT')  { orderParams.price = price; orderParams.timeInForce = 'GTC'; }
      if (type === 'STOP')   { orderParams.stopPrice = stopPrice; }

      const order = await binance('/fapi/v1/order', orderParams, 'POST');

      // 4. TP/SL orders
      const closeSide = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      if (takeProfitPrice) {
        try {
          await binance('/fapi/v1/order', {
            symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET',
            stopPrice: takeProfitPrice, closePosition: 'true',
          }, 'POST');
        } catch (e) {}
      }
      if (stopLossPrice) {
        try {
          await binance('/fapi/v1/order', {
            symbol, side: closeSide, type: 'STOP_MARKET',
            stopPrice: stopLossPrice, closePosition: 'true',
          }, 'POST');
        } catch (e) {}
      }

      return res.status(200).json({ ok: true, orderId: order.orderId, order });
    }

    // ── POST /api/trade?action=close ──────────────────────────────────────
    if (req.method === 'POST' && action === 'close') {
      const { symbol, side, quantity } = req.body;
      const order = await binance('/fapi/v1/order', {
        symbol, side: side.toUpperCase(), type: 'MARKET',
        quantity, reduceOnly: 'true',
      }, 'POST');
      return res.status(200).json({ ok: true, orderId: order.orderId });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[trade.js]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
