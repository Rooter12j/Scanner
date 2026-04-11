// /api/trade.js
const crypto = require('crypto');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol, side, amount } = req.body;
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_SECRET_KEY;
  const timestamp = Date.now();

  // Create the query string for Binance Futures
  const queryString = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${amount}&timestamp=${timestamp}`;
  
  // Sign the request
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  try {
    const response = await fetch(`https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Trade failed', details: err.message });
  }
}