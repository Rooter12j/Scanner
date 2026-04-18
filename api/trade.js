// api/trade.js — Vercel Serverless Function
// Keys: BINANCE_API_KEY + BINANCE_API_SECRET in Vercel Environment Variables

const crypto = require('crypto');

function sign(secret, qs) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function binance(endpoint, params = {}, method = 'GET') {
  const KEY    = (process.env.BINANCE_API_KEY    || '').trim();
  const SECRET = (process.env.BINANCE_API_SECRET || '').trim();

  if (!KEY || !SECRET) {
    throw new Error('KEYS_NOT_SET');
  }

  params.timestamp  = Date.now();
  params.recvWindow = 5000;

  const qs  = new URLSearchParams(params).toString();
  const sig = sign(SECRET, qs);

  let url, fetchOpts;
  if (method === 'POST') {
    url = `https://fapi.binance.com${endpoint}`;
    fetchOpts = {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${qs}&signature=${sig}`,
    };
  } else {
    url = `https://fapi.binance.com${endpoint}?${qs}&signature=${sig}`;
    fetchOpts = {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': KEY },
    };
  }

  const res  = await fetch(url, fetchOpts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Binance non-JSON: ${text.slice(0, 120)}`); }

  if (data.code && data.code < 0) throw new Error(`${data.msg} (code ${data.code})`);
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query.action || '').trim();

  // Parse POST body
  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
    catch (e) { body = {}; }
  }

  // ── DEBUG — visit /api/trade?action=debug to diagnose env var issues ────
  // Remove or comment this out once working
  if (action === 'debug') {
    const KEY    = process.env.BINANCE_API_KEY    || '';
    const SECRET = process.env.BINANCE_API_SECRET || '';
    return res.status(200).json({
      ok: true,
      // Never logs actual key values — only metadata for debugging
      BINANCE_API_KEY_set:    KEY.length > 0,
      BINANCE_API_KEY_length: KEY.length,
      BINANCE_API_KEY_starts: KEY.length > 4 ? KEY.slice(0, 4) + '...' : '(empty)',
      BINANCE_API_SECRET_set:    SECRET.length > 0,
      BINANCE_API_SECRET_length: SECRET.length,
      NODE_ENV:   process.env.NODE_ENV   || '(not set)',
      VERCEL_ENV: process.env.VERCEL_ENV || '(not set)',
      allEnvKeys: Object.keys(process.env)
        .filter(k => k.startsWith('BINANCE') || k.startsWith('VERCEL') || k === 'NODE_ENV')
        .sort(),
    });
  }

  // ── PING ────────────────────────────────────────────────────────────────
  if (action === 'ping') {
    const KEY    = (process.env.BINANCE_API_KEY    || '').trim();
    const SECRET = (process.env.BINANCE_API_SECRET || '').trim();
    const ok     = KEY.length > 10 && SECRET.length > 10;
    return res.status(200).json({
      ok,
      keysConfigured: ok,
      message: ok
        ? `Keys found ✓ (key: ${KEY.slice(0,4)}..., secret: ${SECRET.length} chars)`
        : 'Keys NOT found — check Vercel → Settings → Environment Variables and redeploy',
    });
  }

  try {
    // ── ACCOUNT ─────────────────────────────────────────────────────────
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
        ok:            true,
        balance:       parseFloat(data.totalWalletBalance    || 0),
        unrealizedPnl: parseFloat(data.totalUnrealizedProfit || 0),
        positions,
      });
    }

    // ── PLACE ORDER ─────────────────────────────────────────────────────
    if (action === 'order') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { symbol, side, type, quantity, price, stopPrice,
              leverage, marginType, takeProfitPrice, stopLossPrice } = body;

      if (!symbol || !side || !quantity) {
        return res.status(400).json({ ok: false, error: 'Missing: symbol, side, quantity' });
      }

      // Set leverage (non-fatal if already set)
      try { await binance('/fapi/v1/leverage', { symbol, leverage: leverage || 10 }, 'POST'); }
      catch (e) {}

      // Set margin type (non-fatal if already set)
      try { await binance('/fapi/v1/marginType', { symbol, marginType: (marginType || 'CROSS').toUpperCase() }, 'POST'); }
      catch (e) {}

      // Main order
      const orderParams = {
        symbol,
        side:     side.toUpperCase(),
        type:     (type || 'MARKET').toUpperCase(),
        quantity: String(quantity),
      };
      if ((type || '').toUpperCase() === 'LIMIT') {
        orderParams.price       = String(price);
        orderParams.timeInForce = 'GTC';
      }
      if ((type || '').toUpperCase() === 'STOP') {
        orderParams.stopPrice = String(stopPrice);
      }

      const order = await binance('/fapi/v1/order', orderParams, 'POST');

      // TP / SL
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

    // ── CLOSE POSITION ──────────────────────────────────────────────────
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

    return res.status(400).json({ ok: false, error: `Unknown action: "${action}"` });

  } catch (e) {
    console.error('[trade.js]', action, e.message);

    // Give friendly messages for common Binance errors
    const msg = e.message || '';
    if (msg === 'KEYS_NOT_SET') {
      return res.status(500).json({
        ok: false,
        error: 'API keys not found in environment. Visit /api/trade?action=debug to diagnose, then go to Vercel → Settings → Environment Variables → Redeploy.',
      });
    }
    if (msg.includes('-2015') || msg.includes('Invalid API-key')) {
      return res.status(500).json({ ok: false, error: 'Invalid API key — double-check BINANCE_API_KEY in Vercel env vars' });
    }
    if (msg.includes('-1022') || msg.includes('Signature')) {
      return res.status(500).json({ ok: false, error: 'Invalid signature — double-check BINANCE_API_SECRET in Vercel env vars' });
    }

    return res.status(500).json({ ok: false, error: msg });
  }
};
