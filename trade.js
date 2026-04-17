// api/trade.js — Vercel Serverless Function
// Keys set in: Vercel Dashboard → Project → Settings → Environment Variables
//   BINANCE_API_KEY
//   BINANCE_API_SECRET
//
// Test your keys work: visit /api/trade?action=ping in browser

const crypto = require('crypto');

function sign(secret, qs) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function binance(endpoint, params = {}, method = 'GET') {
  const KEY    = process.env.BINANCE_API_KEY    || '';
  const SECRET = process.env.BINANCE_API_SECRET || '';

  if (!KEY || !SECRET) {
    throw new Error('API keys not configured — add BINANCE_API_KEY and BINANCE_API_SECRET in Vercel → Settings → Environment Variables');
  }

  params.timestamp  = Date.now();
  params.recvWindow = 5000;

  const qs  = new URLSearchParams(params).toString();
  const sig = sign(SECRET, qs);

  // For POST: send params in body. For GET: send in URL.
  let url, fetchOpts;
  if (method === 'POST') {
    url = `https://fapi.binance.com${endpoint}`;
    fetchOpts = {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${qs}&signature=${sig}`,
    };
  } else {
    url = `https://fapi.binance.com${endpoint}?${qs}&signature=${sig}`;
    fetchOpts = { method: 'GET', headers: { 'X-MBX-APIKEY': KEY } };
  }

  const res  = await fetch(url, fetchOpts);
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Binance returned non-JSON: ${text.slice(0, 100)}`); }

  if (data.code && data.code < 0) throw new Error(`${data.msg} (code ${data.code})`);
  return data;
}

module.exports = async function handler(req, res) {
  // CORS — allow browser to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  // Helper to parse body (Vercel doesn't always auto-parse)
  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
    catch (e) { body = {}; }
  }

  try {
    // ── PING — health check, no auth needed ───────────────────────────────
    if (action === 'ping') {
      const keySet = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
      return res.status(200).json({
        ok: true,
        keysConfigured: keySet,
        message: keySet
          ? 'API keys found in env vars ✓'
          : 'API keys NOT set — go to Vercel → Settings → Environment Variables',
      });
    }

    // ── ACCOUNT ───────────────────────────────────────────────────────────
    if (action === 'account') {
      const data = await binance('/fapi/v2/account', {}, 'GET');
      const positions = (data.positions || [])
        .filter(p => parseFloat(p.positionAmt) !== 0)
        .map(p => ({
          symbol:     p.symbol,
          side:       parseFloat(p.positionAmt) > 0 ? 'long' : 'short',
          size:       Math.abs(parseFloat(p.positionAmt)),
          entryPrice: parseFloat(p.entryPrice),
          pnl:        parseFloat(p.unrealizedProfit),
          leverage:   parseFloat(p.leverage),
        }));
      return res.status(200).json({
        ok: true,
        balance:       parseFloat(data.totalWalletBalance   || 0),
        unrealizedPnl: parseFloat(data.totalUnrealizedProfit || 0),
        positions,
      });
    }

    // ── PLACE ORDER ───────────────────────────────────────────────────────
    if (action === 'order') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required for orders' });
      const { symbol, side, type, quantity, price, stopPrice,
              leverage, marginType, takeProfitPrice, stopLossPrice } = body;

      if (!symbol || !side || !quantity) {
        return res.status(400).json({ ok: false, error: 'Missing: symbol, side, quantity' });
      }

      // 1. Set leverage
      try { await binance('/fapi/v1/leverage', { symbol, leverage: leverage || 10 }, 'POST'); }
      catch (e) { /* already set — non-fatal */ }

      // 2. Set margin type
      try { await binance('/fapi/v1/marginType', { symbol, marginType: (marginType || 'CROSS').toUpperCase() }, 'POST'); }
      catch (e) { /* already set — non-fatal */ }

      // 3. Main order
      const orderParams = {
        symbol,
        side:     side.toUpperCase(),
        type:     (type || 'MARKET').toUpperCase(),
        quantity: String(quantity),
      };
      if (type === 'LIMIT')  { orderParams.price = String(price); orderParams.timeInForce = 'GTC'; }
      if (type === 'STOP')   { orderParams.stopPrice = String(stopPrice); }

      const order = await binance('/fapi/v1/order', orderParams, 'POST');

      // 4. TP/SL
      const closeSide = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      if (takeProfitPrice) {
        try {
          await binance('/fapi/v1/order', {
            symbol, side: closeSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: String(takeProfitPrice),
            closePosition: 'true',
          }, 'POST');
        } catch (e) {}
      }
      if (stopLossPrice) {
        try {
          await binance('/fapi/v1/order', {
            symbol, side: closeSide,
            type: 'STOP_MARKET',
            stopPrice: String(stopLossPrice),
            closePosition: 'true',
          }, 'POST');
        } catch (e) {}
      }

      return res.status(200).json({ ok: true, orderId: order.orderId, order });
    }

    // ── CLOSE POSITION ────────────────────────────────────────────────────
    if (action === 'close') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { symbol, side, quantity } = body;
      const order = await binance('/fapi/v1/order', {
        symbol,
        side:       side.toUpperCase(),
        type:       'MARKET',
        quantity:   String(quantity),
        reduceOnly: 'true',
      }, 'POST');
      return res.status(200).json({ ok: true, orderId: order.orderId });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: "${action}". Valid: ping, account, order, close` });

  } catch (e) {
    console.error('[trade.js]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
