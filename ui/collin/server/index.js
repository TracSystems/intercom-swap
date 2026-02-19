import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);

function isServeMode() {
  return process.argv.includes("--serve");
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, id };
}

async function fetchJson(url, opts = {}) {
  const { controller, id } = withTimeout(12_000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: t.slice(0, 500) || res.statusText };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(id);
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * CoinGecko Simple Price (lightweight)
 * /api/coingecko/simple_price?ids=bitcoin,ethereum,solana,trac-network&vs=usd
 */
app.get("/api/coingecko/simple_price", async (req, res) => {
  const ids = String(req.query.ids || "").trim();
  const vs = String(req.query.vs || "usd").trim();
  if (!ids) return res.status(400).json({ ok: false, error: "Missing ids" });

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;
  const out = await fetchJson(url);
  if (!out.ok) return res.status(502).json({ ok: false, source: "coingecko", error: out.error, status: out.status });
  res.json({ ok: true, data: out.data });
});

/**
 * CoinGecko Market Chart
 * /api/coingecko/market_chart?id=bitcoin&vs=usd&days=7
 */
app.get("/api/coingecko/market_chart", async (req, res) => {
  const id = String(req.query.id || "").trim();
  const vs = String(req.query.vs || "usd").trim();
  const days = String(req.query.days || "7").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(days)}`;
  const out = await fetchJson(url);
  if (!out.ok) return res.status(502).json({ ok: false, source: "coingecko", error: out.error, status: out.status });
  res.json({ ok: true, data: out.data });
});

/**
 * DexScreener Token Pairs
 * /api/dex/token_pairs?chain=solana&address=<mint_or_ca>
 */
app.get("/api/dex/token_pairs", async (req, res) => {
  const chain = String(req.query.chain || "").trim();
  const address = String(req.query.address || "").trim();
  if (!chain) return res.status(400).json({ ok: false, error: "Missing chain" });
  if (!address) return res.status(400).json({ ok: false, error: "Missing address" });

  const url = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
  const out = await fetchJson(url);
  if (!out.ok) return res.status(502).json({ ok: false, source: "dexscreener", error: out.error, status: out.status });
  res.json({ ok: true, data: out.data });
});

/**
 * DexScreener Pair Snapshot
 * /api/dex/pair?chain=solana&pair=<pairAddress>
 */
app.get("/api/dex/pair", async (req, res) => {
  const chain = String(req.query.chain || "").trim();
  const pair = String(req.query.pair || "").trim();
  if (!chain) return res.status(400).json({ ok: false, error: "Missing chain" });
  if (!pair) return res.status(400).json({ ok: false, error: "Missing pair" });

  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}`;
  const out = await fetchJson(url);
  if (!out.ok) return res.status(502).json({ ok: false, source: "dexscreener", error: out.error, status: out.status });
  res.json({ ok: true, data: out.data });
});

if (isServeMode()) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SC-BRIDGE] API listening on http://127.0.0.1:${PORT}`);
  if (isServeMode()) console.log(`[SC-BRIDGE] Serving UI from /dist`);
});
