import readline from "readline";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { ethers } from "ethers";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (ans) => res(ans.trim())));

let BASE_URL = process.env.CLI_BASE_URL || "http://127.0.0.1:3000";
let API_KEY = process.env.API_KEY || "";

function mask(v) {
  if (!v) return "(empty)";
  return "********";
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  try {
    const r = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: j };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "fetch_failed",
        message: String(e?.message || e),
        hint: "Server belum jalan atau BASE_URL salah. Jalankan: npm start"
      }
    };
  }
}

// local wallet generators (no server needed)
function genSolLocal() {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secretBase58: bs58.encode(kp.secretKey) };
}

function genEvmLocal() {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

async function menu() {
  console.log("\n=== IntercomSwap ProMax — CLI ===");
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`API Key  : ${mask(API_KEY)}\n`);

  console.log("[1] Health");
  console.log("[2] Set API Key (optional)");
  console.log("[3] Generate SOL Wallet (LOCAL)");
  console.log("[4] Set SOL Wallet to Server (paste secret)");
  console.log("[5] SOL Status (server)");

  console.log("\n[6] Generate EVM Wallet (LOCAL)");
  console.log("[7] Set EVM Wallet to Server (paste privateKey)");
  console.log("[8] EVM Status (server)");

  console.log("\n[9] Token Track (Dexscreener)");
  console.log("[10] Token Analyze (Risk Gate)");
  console.log("[11] Agent Analyze (Detect → Risk → Autofill)");

  console.log("\n[12] Watchlist Add");
  console.log("[13] Watchlist List");
  console.log("[14] Watchlist Remove");

  console.log("\n[15] Change Base URL");
  console.log("[0] Exit\n");
}

async function run() {
  while (true) {
    await menu();
    const pick = await ask("Choose: ");

    if (pick === "0") break;

    if (pick === "1") {
      console.log(await api("/api/health"));
      continue;
    }

    if (pick === "2") {
      API_KEY = await ask("API Key: ");
      console.log("OK (masked).");
      continue;
    }

    if (pick === "3") {
      const w = genSolLocal();
      console.log("\n✅ SOL Wallet Generated (LOCAL)");
      console.log("Address:", w.address);
      console.log("Secret (base58) — simpan baik-baik:");
      console.log(w.secretBase58);
      continue;
    }

    if (pick === "4") {
      const secret = await ask("Paste SOL secret (base58 / JSON array): ");
      console.log(await api("/api/sol/setup", { method: "POST", body: { secret } }));
      continue;
    }

    if (pick === "5") {
      console.log(await api("/api/sol/status"));
      continue;
    }

    if (pick === "6") {
      const w = genEvmLocal();
      console.log("\n✅ EVM Wallet Generated (LOCAL)");
      console.log("Address:", w.address);
      console.log("PrivateKey — simpan baik-baik:");
      console.log(w.privateKey);
      continue;
    }

    if (pick === "7") {
      const privateKey = await ask("Paste EVM privateKey (0x...): ");
      console.log(await api("/api/evm/setup", { method: "POST", body: { privateKey } }));
      continue;
    }

    if (pick === "8") {
      console.log(await api("/api/evm/status"));
      continue;
    }

    if (pick === "9") {
      const address = await ask("Token address/mint: ");
      console.log(await api(`/api/token/track?address=${encodeURIComponent(address)}`));
      continue;
    }

    if (pick === "10") {
      const address = await ask("Token address/mint: ");
      console.log(await api(`/api/token/analyze?address=${encodeURIComponent(address)}`));
      continue;
    }

    if (pick === "11") {
      const text = await ask("Prompt (ex: swap 0.01 SOL to USDC slippage 100 bps): ");
      console.log(await api("/api/agent/analyze", { method: "POST", body: { text } }));
      continue;
    }

    if (pick === "12") {
      const address = await ask("Address/mint: ");
      const note = await ask("Note (optional): ");
      console.log(await api("/api/watchlist/add", { method: "POST", body: { address, note } }));
      continue;
    }

    if (pick === "13") {
      console.log(await api("/api/watchlist"));
      continue;
    }

    if (pick === "14") {
      const address = await ask("Address/mint: ");
      console.log(await api("/api/watchlist/remove", { method: "POST", body: { address } }));
      continue;
    }

    if (pick === "15") {
      BASE_URL = await ask("New BASE_URL (e.g. http://127.0.0.1:3000): ");
      console.log("OK.");
      continue;
    }

    console.log("Unknown menu.");
  }

  rl.close();
}

run();
