<div align="center">

# ⚡ SC-BRIDGE TERMINAL

<p>
  <img src="https://img.shields.io/badge/Status-Stable-brightgreen" />
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue" />
  <img src="https://img.shields.io/badge/UI-React%20%2B%20Vite-9cf" />
  <img src="https://img.shields.io/badge/API-CoinGecko%20%2B%20DexScreener-orange" />
  <img src="https://img.shields.io/badge/Cache-Anti%20429-critical" />
</p>

> Pro Web Dashboard • Market Telemetry • Dex Scanner • CoinGecko Chart  
> Built for **Intercom Task (Trac Systems)**

### 🔗 Trac Address
`0x31d553822B37BDA67126D5ea9d165B9456f72b07`

<p><sub>⚠️ Not financial advice • For telemetry & research only</sub></p>

</div>

---

## 🧠 What is this?

**SC-BRIDGE TERMINAL** is a **localhost-first dashboard** designed to feel like a **pro trading console**:

- 📡 **Realtime market telemetry** (CoinGecko)
- 📊 **Chart timeframes** (7D / 30D / 90D)
- 🔎 **Token scanner** by CA / Mint (DexScreener)
- ⚡ **Server-side caching** to reduce CoinGecko 429 rate-limit issues
- 🖥️ **Clean pro UI** (mobile-friendly)

---

## ✨ Key Features

- ✅ Pro dark dashboard UI
- ✅ CoinGecko price telemetry (cached)
- ✅ Lightweight chart rendering
- ✅ DexScreener CA scanner (Solana supported)
- ✅ Node.js API proxy (keeps keys & calls server-side)
- ✅ Anti rate-limit cache system (stability-first)
- ✅ Mobile-ready layout (VPS friendly)

---
## 📸 Proof

### 🖥️ Dashboard UI
![UI](assets/1.jpg)

### 📊 Live Chart Working
![Chart](assets/2.jpg)

### 🔎 Dex Scanner Section
![Dex](assets/3.jpg)

---

## ⚙️ Run Locally / VPS

### 1) Clone
```bash
git clone https://github.com/nusnuga/SC-BRIDGE-TERMINAL.git
cd SC-BRIDGE-TERMINAL/ui/collin
```

### 2) Install
```bash
npm install
```

### 3) Start API Server
```bash
node server/index.js
```

### 4) Start Web UI
```bash
npm run dev -- --host
```

### 5) Open
Local:
```
http://localhost:5173
```

VPS:
```
http://YOUR_SERVER_IP:5173
```

---

## 🔌 API Endpoints

- `GET /api/health`
- `GET /api/coingecko/simple_price`
- `GET /api/coingecko/market_chart`

---

## ⚠️ Notes

- CoinGecko can return `429` (rate limit)
- Server caching reduces spam & keeps UI stable
- Dex scanner requires valid **CA / Mint**
- This tool does **not** guarantee accuracy or profits

---

## 🧱 Tech Stack

- **React + Vite**
- **Node.js** (API Proxy)
- **CoinGecko API**
- **DexScreener API**
- **Lightweight Charts**

---

## ✅ Status Checklist

- ✅ UI: Stable
- ✅ API: Running
- ✅ Chart: Working
- ✅ VPS Deploy: Success

---

<div align="center">

### 🔥 Built for Intercom • Trac Systems Task  
<sub>SC-BRIDGE TERMINAL — telemetry-grade dashboard for fast token scanning</sub>

</div>
