// Shared Binance REST helper used by all /api/* serverless functions
// Runs on Vercel server-side → no CORS issues

import crypto from "crypto";

const IS_TEST  = process.env.BINANCE_TESTNET === "true";
const BASE_URL = IS_TEST
  ? "https://testnet.binance.vision"
  : "https://api.binance.com";

function sign(queryString, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(queryString)
    .digest("hex");
}

export async function binanceRequest(method, path, params = {}) {
  const apiKey    = process.env.BINANCE_API_KEY    || "";
  const apiSecret = process.env.BINANCE_API_SECRET || "";

  if (!apiKey || !apiSecret) {
    throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET not set in environment variables");
  }

  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const qs        = new URLSearchParams(allParams).toString();
  const signature = sign(qs, apiSecret);
  const fullQS    = `${qs}&signature=${signature}`;

  const url      = `${BASE_URL}${path}?${fullQS}`;
  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    ...(method === "POST" || method === "DELETE"
      ? { body: fullQS }
      : {}),
  });

  const data = await response.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance [${data.code}]: ${data.msg}`);
  }
  return data;
}

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
