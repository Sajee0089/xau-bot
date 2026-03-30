// GET /api/health → check env vars are set
import { cors } from "./_binance.js";

export default function handler(req, res) {
  cors(res);
  res.status(200).json({
    ok:      true,
    testnet: process.env.BINANCE_TESTNET === "true",
    keySet:  !!process.env.BINANCE_API_KEY,
    time:    new Date().toISOString(),
  });
}
