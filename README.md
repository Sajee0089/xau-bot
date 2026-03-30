# ⚡ XAU/USDT Trading Bot
Real-time Binance gold trading bot — Paper + Live trading — GitHub + Vercel

## Features
- **Real-time** Binance WebSocket price feed (no API key for chart)
- **Paper trading** — auto-trades with simulated balance, no real money
- **Live trading** — real Binance market orders via Vercel serverless functions
- **Triple EMA strategy** — EMA9 + EMA21 + EMA50 confluence scoring
- **RSI + Volume + S/R** confirmation layers
- **Auto-breakeven** — SL moves to entry after TP1 hit
- **Vercel serverless API** — solves CORS completely, no proxy needed

---

## Deploy in 5 Minutes

### Step 1 — GitHub
```bash
# Create a new repo on github.com, then:
git init
git add .
git commit -m "XAU bot initial"
git remote add origin https://github.com/YOUR_USERNAME/xau-bot.git
git push -u origin main
```

### Step 2 — Vercel
1. Go to **vercel.com** → New Project → Import from GitHub
2. Select your repo → Deploy (leave all settings default)
3. Go to **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `BINANCE_API_KEY` | Your Binance API key |
| `BINANCE_API_SECRET` | Your Binance API secret |
| `BINANCE_TESTNET` | `true` (testnet) or `false` (mainnet) |

4. Go to **Deployments → Redeploy** (to pick up env vars)

### Step 3 — Get API Keys

**For Testnet (recommended first):**
- Go to https://testnet.binance.vision
- Login with GitHub → Generate HMAC API Key
- Copy Key + Secret

**For Mainnet (real money):**
- Go to https://www.binance.com/en/my/settings/api-management
- Create API key with: ✅ Enable Reading + ✅ Enable Spot Trading
- Restrict to Vercel's IP range for security

---

## Local Development

```bash
# Install dependencies
npm install

# Install Vercel CLI
npm install -g vercel

# Run locally (starts both Vite dev server + serverless functions)
vercel dev

# Open http://localhost:3000
```

---

## Architecture

```
Browser
├── Public REST (api.binance.com/klines)    ← CORS allowed ✅
├── Public WebSocket (stream.binance.com)    ← No CORS ✅
└── /api/* → Vercel Serverless Functions     ← Server-side, no CORS ✅
    ├── /api/account    → GET account balance
    ├── /api/order      → POST/DELETE orders
    ├── /api/openOrders → GET open orders
    ├── /api/trades     → GET trade history
    └── /api/health     → Check env vars set
```

---

## Strategy Logic

| Layer | Indicator | Weight |
|---|---|---|
| Trend alignment | EMA9 > EMA21 > EMA50 | +20 pts |
| Primary entry | Price crosses EMA21 | +25 pts |
| Momentum | EMA9 crosses EMA21 | +15 pts |
| RSI zone | 35–55 bull / 45–65 bear | +15 pts |
| RSI extreme | <35 oversold / >65 overbought | +20 pts |
| Support/Resistance | Price at pivot level | +20 pts |
| Volume confirmation | 1.8× average volume | +15 pts |

Signal fires when total score ≥55%. Auto-trade fires at ≥55% (paper) — adjust threshold in `App.jsx` `getSignal()`.

---

## Risk Warning
⚠ Live trading uses real money. Always test on Testnet first.
This software is for educational purposes. Past performance does not guarantee future results.
