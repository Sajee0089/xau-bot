// GET /api/klines?symbol=XAUUSDT&interval=15m&limit=200
// Tries multiple Binance endpoints + falls back to CoinGecko for chart data
import { cors } from "./_binance.js";

const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
];

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const {
    symbol   = "XAUUSDT",
    interval = "15m",
    limit    = "200",
  } = req.query;

  // ── Try each Binance endpoint ────────────────────────────
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const r   = await fetch(url, {
        signal:  AbortSignal.timeout(6000),
        headers: { "Accept": "application/json" },
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data)) continue;
      return res.status(200).json({ ok: true, source: "binance", data });
    } catch (_) {
      // try next endpoint
    }
  }

  // ── Fallback: CoinGecko OHLC (free, no key, no IP blocks) ──
  // Maps 15m → closest available (1h for CoinGecko free tier)
  try {
    // days=1 gives hourly OHLC which is enough to render a chart
    const cgUrl = "https://api.coingecko.com/api/v3/coins/tether-gold/ohlc?vs_currency=usd&days=7";
    const cgRes = await fetch(cgUrl, { signal: AbortSignal.timeout(8000) });
    if (cgRes.ok) {
      const raw  = await cgRes.json(); // [[timestamp, o, h, l, c], ...]
      if (Array.isArray(raw) && raw.length > 0) {
        // Convert CoinGecko format → Binance kline format
        const data = raw.map(r => [
          r[0],        // open time
          String(r[1]),// open
          String(r[2]),// high
          String(r[3]),// low
          String(r[4]),// close
          "0",         // volume (not available)
          r[0] + 3600000, // close time
          "0","0","0","0","0"
        ]);
        return res.status(200).json({ ok: true, source: "coingecko", data });
      }
    }
  } catch (_) {}

  // ── All sources failed ────────────────────────────────────
  res.status(500).json({
    ok:    false,
    error: "All data sources failed. Binance may be blocked in your server region. Check Vercel function logs.",
    tried: BINANCE_ENDPOINTS.length + " Binance endpoints + CoinGecko",
  });
}
