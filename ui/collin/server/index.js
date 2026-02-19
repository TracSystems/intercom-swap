import http from "http";
import { URL } from "url";

const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 200, { ok: true });

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return send(res, 200, { ok: true, name: "sc-bridge-terminal-api", port: PORT });
    }

    // fallback
    return send(res, 404, { ok: false, error: "Not found", path: url.pathname });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[SC-BRIDGE] API listening on http://${HOST}:${PORT}`);
});
