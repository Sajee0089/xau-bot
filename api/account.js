// GET /api/account → Binance account info + balances
import { binanceRequest, cors } from "./_binance.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const data = await binanceRequest("GET", "/api/v3/account");
    // Return only what the frontend needs
    const usdt = data.balances?.find(b => b.asset === "USDT");
    const xau  = data.balances?.find(b => b.asset === "XAU");
    res.status(200).json({
      ok:          true,
      accountType: data.accountType,
      canTrade:    data.canTrade,
      usdt:        usdt ? { free: usdt.free, locked: usdt.locked } : null,
      xau:         xau  ? { free: xau.free,  locked: xau.locked  } : null,
      permissions: data.permissions,
      testnet:     process.env.BINANCE_TESTNET === "true",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
