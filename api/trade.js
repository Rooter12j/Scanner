// api/trade.js — Vercel Serverless Function
// Keys: BINANCE_API_KEY + BINANCE_API_SECRET in Vercel Environment Variables

const crypto = require('crypto');

function sign(secret, qs) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function binance(endpoint, params = {}, method = 'GET') {
  const KEY    = (process.env.BINANCE_API_KEY    || '').trim();
  const SECRET = (process.env.BINANCE_API_SECRET || '').trim();

  if (!KEY || !SECRET) throw new Error('KEYS_NOT_SET');

  params.timestamp  = Date.now();
  params.recvWindow = 5000;

  const qs  = new URLSearchParams(params).toString();
  const sig = sign(SECRET, qs);

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
  catch (e) { throw new Error(`Binance non-JSON: ${text.slice(0, 120)}`); }

  if (data.code && data.code < 0) throw new Error(`${data.msg} (code ${data.code})`);
  return data;
}

// Separate call for spot wallet (no futures endpoint needed)
async function binanceSpot(endpoint, params = {}) {
  const KEY    = (process.env.BINANCE_API_KEY    || '').trim();
  const SECRET = (process.env.BINANCE_API_SECRET || '').trim();

  if (!KEY || !SECRET) throw new Error('KEYS_NOT_SET');

  params.timestamp  = Date.now();
  params.recvWindow = 5000;

  const qs  = new URLSearchParams(params).toString();
  const sig = sign(SECRET, qs);
  const url = `https://api.binance.com${endpoint}?${qs}&signature=${sig}`;

  const res  = await fetch(url, { headers: { 'X-MBX-APIKEY': KEY } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Binance spot non-JSON: ${text.slice(0, 120)}`); }
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

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
    catch (e) { body = {}; }
  }

  // ── DEBUG ──────────────────────────────────────────────────────────────
  if (action === 'debug') {
    const KEY    = process.env.BINANCE_API_KEY    || '';
    const SECRET = process.env.BINANCE_API_SECRET || '';
    return res.status(200).json({
      ok: true,
      BINANCE_API_KEY_set:       KEY.length > 0,
      BINANCE_API_KEY_length:    KEY.length,
      BINANCE_API_KEY_starts:    KEY.length > 4 ? KEY.slice(0,4)+'...' : '(empty)',
      BINANCE_API_SECRET_set:    SECRET.length > 0,
      BINANCE_API_SECRET_length: SECRET.length,
      VERCEL_ENV: process.env.VERCEL_ENV || '(not set)',
    });
  }

  // ── PING ──────────────────────────────────────────────────────────────
  if (action === 'ping') {
    const KEY    = (process.env.BINANCE_API_KEY    || '').trim();
    const SECRET = (process.env.BINANCE_API_SECRET || '').trim();
    const ok     = KEY.length > 10 && SECRET.length > 10;
    return res.status(200).json({
      ok, keysConfigured: ok,
      message: ok ? `Keys found ✓` : 'Keys NOT set — check Vercel env vars and redeploy',
    });
  }

  try {

    // ── ACCOUNT ───────────────────────────────────────────────────────────
    // Reads BOTH futures wallet AND spot USDT so nothing is missed
    if (action === 'account') {

      // 1. Futures account info
      const futuresData = await binance('/fapi/v2/account', {}, 'GET');

      // Futures wallet fields — try all of them
      const futuresWallet  = parseFloat(futuresData.totalWalletBalance    || 0);
      const availBalance   = parseFloat(futuresData.availableBalance       || 0);
      const marginBalance  = parseFloat(futuresData.totalMarginBalance     || 0);
      const unrealizedPnl  = parseFloat(futuresData.totalUnrealizedProfit  || 0);

      // Asset-level USDT balance (more reliable than top-level fields)
      let assetBalance = 0;
      if (Array.isArray(futuresData.assets)) {
        const usdtAsset = futuresData.assets.find(a => a.asset === 'USDT');
        if (usdtAsset) {
          assetBalance = parseFloat(usdtAsset.walletBalance || usdtAsset.availableBalance || 0);
        }
      }

      // 2. Spot wallet USDT (in case user hasn't transferred to futures yet)
      let spotUSDT = 0;
      try {
        const spotData = await binanceSpot('/api/v3/account', {});
        if (Array.isArray(spotData.balances)) {
          const usdt = spotData.balances.find(b => b.asset === 'USDT');
          if (usdt) spotUSDT = parseFloat(usdt.free || 0) + parseFloat(usdt.locked || 0);
        }
      } catch (e) {
        // Spot read failed — not critical
        console.warn('Spot balance read failed:', e.message);
      }

      // Pick the best balance to show — prefer futures asset balance
      const bestBalance = assetBalance > 0 ? assetBalance
        : futuresWallet > 0 ? futuresWallet
        : availBalance  > 0 ? availBalance
        : marginBalance > 0 ? marginBalance
        : 0;

      // Open positions
      const positions = (futuresData.positions || [])
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
        // Send all balance fields so frontend can pick the right one
        balance:        bestBalance,
        futuresWallet,
        availBalance,
        marginBalance,
        unrealizedPnl,
        spotUSDT,
        positions,
        // Debug info visible in browser devtools
        _debug: {
          rawTotalWalletBalance:   futuresData.totalWalletBalance,
          rawAvailableBalance:     futuresData.availableBalance,
          rawTotalMarginBalance:   futuresData.totalMarginBalance,
          assetBalance,
          spotUSDT,
        },
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

      try { await binance('/fapi/v1/leverage', { symbol, leverage: leverage || 10 }, 'POST'); }
      catch (e) {}

      try { await binance('/fapi/v1/marginType', { symbol, marginType: (marginType || 'CROSS').toUpperCase() }, 'POST'); }
      catch (e) {}

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
    const msg = e.message || '';
    if (msg === 'KEYS_NOT_SET')
      return res.status(500).json({ ok: false, error: 'API keys not found — check Vercel env vars and redeploy' });
    if (msg.includes('-2015') || msg.includes('Invalid API-key'))
      return res.status(500).json({ ok: false, error: 'Invalid API key — check BINANCE_API_KEY in Vercel' });
    if (msg.includes('-1022') || msg.includes('Signature'))
      return res.status(500).json({ ok: false, error: 'Invalid signature — check BINANCE_API_SECRET in Vercel' });
    return res.status(500).json({ ok: false, error: msg });
  }
};
