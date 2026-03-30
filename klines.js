// GET /api/klines?symbol=XAUUSDT&interval=15m&limit=200
// Routes through Vercel server → bypasses Binance regional blocks + CORS
import { cors } from "./_binance.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol = "XAUUSDT", interval = "15m", limit = 200 } = req.query;

  // Try mainnet first, fall back to alternative endpoint
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api1.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api2.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      lastError = e;
    }
  }
  res.status(500).json({ ok: false, error: lastError?.message || "All endpoints failed" });
}
