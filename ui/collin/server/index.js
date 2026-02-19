import http from "http";
import { URL } from "url";

const PORT = 8787;
const HOST = "127.0.0.1";

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: {
      "accept": "application/json"
    }
  });
  return await r.json();
}

function send(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ✅ HEALTH
    if (url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    // ✅ SIMPLE PRICE
    if (url.pathname === "/api/coingecko/simple_price") {
      const ids = url.searchParams.get("ids");
      const vs = url.searchParams.get("vs") || "usd";

      const data = await fetchJSON(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true`
      );

      return send(res, 200, { ok: true, data });
    }

    // ✅ MARKET CHART
    if (url.pathname === "/api/coingecko/market_chart") {
      const id = url.searchParams.get("id");
      const vs = url.searchParams.get("vs") || "usd";
      const days = url.searchParams.get("days") || "7";

      const data = await fetchJSON(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`
      );

      return send(res, 200, { ok: true, data });
    }

    // ❌ fallback
    return send(res, 404, { ok: false, error: "Not found" });

  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[SC-BRIDGE] API listening on http://${HOST}:${PORT}`);
});
