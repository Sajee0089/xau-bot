// GET /api/trades?symbol=XAUUSDT&limit=50
import { binanceRequest, cors } from "./_binance.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const { symbol, limit = 50 } = req.query;
    const data = await binanceRequest("GET", "/api/v3/myTrades", { symbol, limit });
    res.status(200).json({ ok: true, trades: data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
