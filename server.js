const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "web")));

const TRAC_STORE = path.join(__dirname, "tools", "trac", "trac_addresses.json");
function loadTracStore() {
  try { return JSON.parse(fs.readFileSync(TRAC_STORE, "utf8")); }
  catch { return { addresses: [] }; }
}
function saveTracStore(data) {
  fs.writeFileSync(TRAC_STORE, JSON.stringify(data, null, 2));
}

app.get("/api/bots", (req, res) => {
  res.json([
    { id: "swap_loop", name: "Swap Simulator Loop", desc: "ETH(1inch) + SOL(Jupiter) quotes (read-only)." },
    { id: "trac_tracker", name: "TRAC Address Tracker", desc: "Save addresses + open explorer quickly." },
    { id: "charts", name: "Token Charts", desc: "Pick token → price chart (CoinGecko)." },
  ]);
});

/** ---------------- SWAP QUOTES (read-only) ---------------- **/
app.post("/api/quote/eth", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount } = req.body || {};
    const quote = await require("./tools/swap-engine/eth_1inch_quote")(sellToken, buyToken, sellAmount);
    res.json({ ok: true, quote });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/quote/sol", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.body || {};
    const quote = await require("./tools/swap-engine/sol_jup_quote")(inputMint, outputMint, amount, slippageBps);
    res.json({ ok: true, quote });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

/** ---------------- TRAC TRACKER ---------------- **/
app.get("/api/trac/list", (req, res) => {
  const db = loadTracStore();
  res.json({ ok: true, addresses: db.addresses });
});

app.post("/api/trac/add", (req, res) => {
  const { address, label } = req.body || {};
  if (!address) return res.status(400).json({ ok: false, error: "address required" });
  const db = loadTracStore();
  const exists = db.addresses.find(x => x.address === address);
  if (!exists) db.addresses.push({ address, label: label || "TRAC Wallet" });
  saveTracStore(db);
  res.json({ ok: true, addresses: db.addresses });
});

app.post("/api/trac/remove", (req, res) => {
  const { address } = req.body || {};
  const db = loadTracStore();
  db.addresses = db.addresses.filter(x => x.address !== address);
  saveTracStore(db);
  res.json({ ok: true, addresses: db.addresses });
});

app.get("/api/trac/explorer", (req, res) => {
  const address = String(req.query.address || "");
  if (!address) return res.status(400).json({ ok: false, error: "address query required" });
  const url = `https://explorer.trac.network/address/${encodeURIComponent(address)}`;
  res.json({ ok: true, url });
});

/** ---------------- CHARTS (CoinGecko proxy) ---------------- **/
const fetch = require("node-fetch");

// GET /api/chart?token=bitcoin&days=30
app.get("/api/chart", async (req, res) => {
  try {
    const token = String(req.query.token || "bitcoin").toLowerCase();
    const days = String(req.query.days || "30");
    const url = `https://api.coingecko.com/api/v3/coins/${token}/market_chart?vs_currency=usd&days=${days}`;
    const r = await fetch(url, { headers: { "accept": "application/json" } });
    const data = await r.json();
    if (!r.ok) throw new Error(`CoinGecko error: ${JSON.stringify(data).slice(0, 200)}`);
    res.json({ ok: true, token, days, prices: data.prices || [] });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dashboard running: http://127.0.0.1:${PORT}`);
});
