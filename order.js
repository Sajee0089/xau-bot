// POST /api/order → place market order
// DELETE /api/order → cancel order
import { binanceRequest, cors } from "./_binance.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "POST") {
      // Place MARKET order
      const { symbol, side, quantity } = req.body;
      if (!symbol || !side || !quantity) {
        return res.status(400).json({ ok: false, error: "Missing symbol/side/quantity" });
      }
      const data = await binanceRequest("POST", "/api/v3/order", {
        symbol,
        side:     side.toUpperCase(),
        type:     "MARKET",
        quantity: String(quantity),
      });
      return res.status(200).json({ ok: true, ...data });
    }

    if (req.method === "DELETE") {
      // Cancel order
      const { symbol, orderId } = req.query;
      const data = await binanceRequest("DELETE", "/api/v3/order", { symbol, orderId });
      return res.status(200).json({ ok: true, ...data });
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
