// GET /api/openOrders?symbol=XAUUSDT
import { binanceRequest, cors } from "./_binance.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const { symbol } = req.query;
    const data = await binanceRequest("GET", "/api/v3/openOrders", { symbol });
    res.status(200).json({ ok: true, orders: data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
