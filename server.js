import "dotenv/config";
import express from "express";
import cors from "cors";
import bs58 from "bs58";
import { ethers } from "ethers";
import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

/**
 * 🔒 SAFE DEFAULTS
 * - HOST default 127.0.0.1 (private, aman)
 * - MODE=test + DRY_RUN=1 (no broadcast)
 */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const MODE = (process.env.MODE || "test").toLowerCase(); // test | mainnet
const DRY_RUN = (process.env.DRY_RUN || "1") === "1" || MODE === "test";

console.log(`🚀 MODE: ${MODE.toUpperCase()} | DRY_RUN: ${DRY_RUN}`);
console.log(`🔒 HOST: ${HOST}:${PORT}`);

const API_KEY = process.env.API_KEY || "";

// Groq (optional)
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// RPCs
const RPC_ETH = process.env.EVM_RPC_ETH || "";
const RPC_BSC = process.env.EVM_RPC_BSC || "";
const RPC_BASE = process.env.EVM_RPC_BASE || "";

// Solana RPC: test mode default devnet
const SOL_RPC =
  process.env.SOL_RPC ||
  (MODE === "test" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

// 0x / LI.FI keys (optional)
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || "";

const CHAIN = {
  eth: { chainId: 1, name: "Ethereum", rpc: RPC_ETH, native: "ETH", explorer: "https://etherscan.io/tx/" },
  bsc: { chainId: 56, name: "BSC", rpc: RPC_BSC, native: "BNB", explorer: "https://bscscan.com/tx/" },
  base: { chainId: 8453, name: "Base", rpc: RPC_BASE, native: "ETH", explorer: "https://basescan.org/tx/" },
};

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const k = req.headers["x-api-key"];
  if (k && k === API_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (x-api-key)" });
}

function maskAddr(a) {
  if (!a) return null;
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isEvmAddress(x) {
  return typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x.trim());
}

function isProbablySolAddress(x) {
  return typeof x === "string" && x.trim().length >= 32 && x.trim().length <= 50 && !x.trim().startsWith("0x");
}

function parseSolSecret(input) {
  const s = (input || "").trim();
  if (!s) throw new Error("Empty SOL secret");

  // JSON array
  if (s.startsWith("[")) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error("Invalid JSON array");
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  // base58
  const bytes = bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

function parseEvmPk(input) {
  const s = (input || "").trim();
  if (!s) throw new Error("Empty EVM private key");
  const pk = s.startsWith("0x") ? s : `0x${s}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) throw new Error("Invalid EVM private key format");
  return pk;
}

// RAM-only wallets
const mem = {
  sol: { kp: null, address: null },
  evm: {
    eth: { wallet: null, address: null },
    bsc: { wallet: null, address: null },
    base: { wallet: null, address: null },
  },
};

function getProvider(chainKey) {
  const c = CHAIN[chainKey];
  if (!c?.rpc) throw new Error(`Missing RPC for ${chainKey}`);
  return new ethers.JsonRpcProvider(c.rpc, c.chainId);
}

function riskGate({ chain, amountInHuman, slippageBps, mode }) {
  const issues = [];
  const warnings = [];

  const amt = Number(amountInHuman);
  const slip = Number(slippageBps);

  if (!Number.isFinite(amt) || amt <= 0) issues.push("Amount must be > 0");
  if (!Number.isFinite(slip) || slip <= 0) warnings.push("Slippage not set/invalid. Try 50–150 bps.");
  if (slip > 300) warnings.push("High slippage (>3%) — higher MEV/sandwich risk.");

  if (chain === "sol" && amt >= 1) warnings.push("Large SOL amount — start small, use burner wallet.");
  if ((chain === "eth" || chain === "base") && amt >= 0.2) warnings.push("Large amount — do a tiny test tx first.");
  if (chain === "bsc" && amt >= 1) warnings.push("Large amount — do a tiny test tx first.");

  if (mode === "bridge") warnings.push("Bridge risk: route failures/delays/extra fees.");

  if (DRY_RUN) warnings.push("DRY_RUN enabled: transaction will NOT be broadcasted.");

  return { ok: issues.length === 0, issues, warnings };
}

async function groqParse(userText) {
  if (!GROQ_API_KEY) {
    return {
      intent: "unknown",
      chain: null,
      action: "unknown",
      tokenIn: null,
      tokenOut: null,
      amount: null,
      slippageBps: 100,
      notes: ["GROQ_API_KEY not set — fallback detectors only."],
    };
  }

  const sys =
    `Return ONLY valid JSON with keys:
intent: "swap"|"bridge"|"balance"|"status"|"help"|"unknown"
chain: "sol"|"eth"|"bsc"|"base"|null
tokenIn: string|null
tokenOut: string|null
amount: string|null
slippageBps: number
action: "execute_swap"|"execute_bridge"|"show_balance"|"quote"|"unknown"
notes: array of strings

Rules:
- If you see 0x address, assume EVM token.
- If you see Solana mint/address, assume sol.
- If chain missing for EVM, set chain null.
- slippageBps clamp 10..500
No extra text.`;

  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
  };

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Groq error: ${r.status} ${t}`);
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content?.trim() || "";
  return JSON.parse(content);
}

/* ================= API ================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mode: MODE,
    dryRun: DRY_RUN,
    apiKeyEnabled: !!API_KEY,
    groq: !!GROQ_API_KEY,
    groqModel: GROQ_MODEL,
    rpc: { sol: SOL_RPC, eth: !!RPC_ETH, bsc: !!RPC_BSC, base: !!RPC_BASE },
    wallets: {
      sol: !!mem.sol.kp,
      eth: !!mem.evm.eth.wallet,
      bsc: !!mem.evm.bsc.wallet,
      base: !!mem.evm.base.wallet,
    },
  });
});

/* -------- Generate burner wallets -------- */
app.post("/api/gen/sol", requireApiKey, (req, res) => {
  try {
    const kp = Keypair.generate();
    res.json({
      ok: true,
      address: kp.publicKey.toBase58(),
      secretJson: JSON.stringify(Array.from(kp.secretKey)),
      secretBase58: bs58.encode(kp.secretKey),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/gen/evm", requireApiKey, (req, res) => {
  try {
    const w = ethers.Wallet.createRandom();
    res.json({ ok: true, address: w.address, privateKey: w.privateKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- Wallet setup -------- */
app.post("/api/wallet/sol", requireApiKey, (req, res) => {
  try {
    const kp = parseSolSecret(req.body?.secret);
    mem.sol.kp = kp;
    mem.sol.address = kp.publicKey.toBase58();
    res.json({ ok: true, address: mem.sol.address, addressMasked: maskAddr(mem.sol.address) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/wallet/evm", requireApiKey, async (req, res) => {
  try {
    const chain = String(req.body?.chain || "").toLowerCase();
    if (!CHAIN[chain]) throw new Error("Invalid chain (use eth/bsc/base)");
    const pk = parseEvmPk(req.body?.privateKey);
    const provider = getProvider(chain);
    const wallet = new ethers.Wallet(pk, provider);
    mem.evm[chain].wallet = wallet;
    mem.evm[chain].address = await wallet.getAddress();
    res.json({ ok: true, chain, address: mem.evm[chain].address, addressMasked: maskAddr(mem.evm[chain].address) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- Balances -------- */
app.get("/api/sol/balance", requireApiKey, async (req, res) => {
  try {
    if (!mem.sol.kp) throw new Error("SOL wallet not set");
    const connection = new Connection(SOL_RPC, "confirmed");
    const lamports = await connection.getBalance(mem.sol.kp.publicKey, "confirmed");
    res.json({ ok: true, address: mem.sol.address, lamports, sol: lamports / LAMPORTS_PER_SOL, rpc: SOL_RPC });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/evm/balance", requireApiKey, async (req, res) => {
  try {
    const chain = String(req.query?.chain || "").toLowerCase();
    if (!CHAIN[chain]) throw new Error("Invalid chain (use eth/bsc/base)");
    if (!mem.evm[chain].wallet) throw new Error(`EVM wallet not set for ${chain}`);
    const provider = getProvider(chain);
    const addr = await mem.evm[chain].wallet.getAddress();
    const bal = await provider.getBalance(addr);
    res.json({ ok: true, chain, address: addr, wei: bal.toString(), native: ethers.formatEther(bal) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- SOL Swap (Jupiter) --------
 * inputMint default: wSOL mint
 * outputMint: target mint
 * amountLamports: integer
 */
app.post("/api/sol/swap", requireApiKey, async (req, res) => {
  try {
    if (!mem.sol.kp) throw new Error("SOL wallet not set");

    const inputMint = (req.body?.inputMint || "So11111111111111111111111111111111111111112").trim();
    const outputMint = String(req.body?.outputMint || "").trim();
    const amountLamports = String(req.body?.amountLamports || "").trim();
    const slippageBps = Number(req.body?.slippageBps ?? 100);

    if (!outputMint) throw new Error("outputMint required");
    if (!/^\d+$/.test(amountLamports)) throw new Error("amountLamports must be integer string");

    const risk = riskGate({
      chain: "sol",
      amountInHuman: Number(amountLamports) / LAMPORTS_PER_SOL,
      slippageBps,
      mode: "swap",
    });
    if (!risk.ok) return res.status(400).json({ ok: false, error: "risk_blocked", risk });

    // Quote (Jupiter)
    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote?inputMint=${encodeURIComponent(inputMint)}` +
      `&outputMint=${encodeURIComponent(outputMint)}` +
      `&amount=${encodeURIComponent(amountLamports)}` +
      `&slippageBps=${encodeURIComponent(String(slippageBps))}`;

    const qRes = await fetch(quoteUrl);
    const quoteJson = await qRes.json();
    if (!qRes.ok) throw new Error(`Jupiter quote error: ${qRes.status} ${JSON.stringify(quoteJson).slice(0, 300)}`);

    // Swap TX (Jupiter)
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteJson,
        userPublicKey: mem.sol.address,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });

    const swapJson = await swapRes.json();
    if (!swapRes.ok) throw new Error(`Jupiter swap error: ${swapRes.status} ${JSON.stringify(swapJson).slice(0, 300)}`);

    const txB64 = swapJson?.swapTransaction;
    if (!txB64) throw new Error("Missing swapTransaction in Jupiter response");

    // Deserialize + sign
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
    tx.sign([mem.sol.kp]);

    // ✅ SAFE MODE: do not broadcast
    if (DRY_RUN) {
      return res.json({
        ok: true,
        dryRun: true,
        mode: MODE,
        chain: "sol",
        note: "TX built + signed but NOT broadcasted (safe test mode)",
        risk,
        user: mem.sol.address,
        quote: quoteJson,
        signedTxBase64: Buffer.from(tx.serialize()).toString("base64"),
      });
    }

    // REAL send
    const connection = new Connection(SOL_RPC, "confirmed");
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");

    return res.json({
      ok: true,
      mode: MODE,
      chain: "sol",
      signature: sig,
      explorer: `https://solscan.io/tx/${sig}`,
      risk,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- EVM Swap (0x) --------
 * sellToken: 0x.. or ETH/BNB
 * buyToken:  0x.. or ETH/BNB
 * sellAmountWei: integer string
 */
app.post("/api/evm/swap", requireApiKey, async (req, res) => {
  try {
    const chain = String(req.body?.chain || "").toLowerCase();
    if (!CHAIN[chain]) throw new Error("Invalid chain (use eth/bsc/base)");
    if (!mem.evm[chain].wallet) throw new Error(`EVM wallet not set for ${chain}`);

    const sellToken = String(req.body?.sellToken || "").trim();
    const buyToken = String(req.body?.buyToken || "").trim();
    const sellAmountWei = String(req.body?.sellAmountWei || "").trim();
    const slippageBps = Number(req.body?.slippageBps ?? 100);

    if (!sellToken) throw new Error("sellToken required");
    if (!buyToken) throw new Error("buyToken required");
    if (!/^\d+$/.test(sellAmountWei)) throw new Error("sellAmountWei must be integer string");

    const risk = riskGate({
      chain,
      amountInHuman: "(wei)",
      slippageBps,
      mode: "swap",
    });
    if (!risk.ok) return res.status(400).json({ ok: false, error: "risk_blocked", risk });

    const taker = await mem.evm[chain].wallet.getAddress();

    // 0x quote (swap/v1/quote)
    const base = "https://api.0x.org/swap/v1/quote";
    const url =
      `${base}?sellToken=${encodeURIComponent(sellToken)}` +
      `&buyToken=${encodeURIComponent(buyToken)}` +
      `&sellAmount=${encodeURIComponent(sellAmountWei)}` +
      `&takerAddress=${encodeURIComponent(taker)}` +
      `&slippagePercentage=${encodeURIComponent(String(slippageBps / 10000))}`;

    const headers = { "content-type": "application/json" };
    if (ZEROX_API_KEY) headers["0x-api-key"] = ZEROX_API_KEY;

    const qRes = await fetch(url, { headers });
    const quote = await qRes.json();
    if (!qRes.ok) throw new Error(`0x quote error: ${qRes.status} ${JSON.stringify(quote).slice(0, 300)}`);

    // Build tx
    const tx = {
      to: quote.to,
      data: quote.data,
      value: quote.value ? BigInt(quote.value) : 0n,
    };

    // ✅ SAFE MODE: do not broadcast
    if (DRY_RUN) {
      return res.json({
        ok: true,
        dryRun: true,
        mode: MODE,
        chain,
        note: "0x quote received but NOT executed (safe test mode)",
        risk,
        taker,
        quote,
        tx,
      });
    }

    // REAL send
    const sent = await mem.evm[chain].wallet.sendTransaction(tx);
    await sent.wait();

    return res.json({
      ok: true,
      mode: MODE,
      chain,
      hash: sent.hash,
      explorer: `${CHAIN[chain].explorer}${sent.hash}`,
      risk,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- Bridge Execute (LI.FI EVM↔EVM) --------
 * fromChain/toChain: eth|bsc|base
 * fromToken/toToken: 0x..
 * fromAmountWei: integer string
 */
app.post("/api/bridge/evm", requireApiKey, async (req, res) => {
  try {
    const fromChain = String(req.body?.fromChain || "").toLowerCase();
    const toChain = String(req.body?.toChain || "").toLowerCase();
    if (!CHAIN[fromChain] || !CHAIN[toChain]) throw new Error("Invalid chain(s) (use eth/bsc/base)");
    if (!mem.evm[fromChain].wallet) throw new Error(`EVM wallet not set for ${fromChain}`);

    const fromToken = String(req.body?.fromToken || "").trim();
    const toToken = String(req.body?.toToken || "").trim();
    const fromAmountWei = String(req.body?.fromAmountWei || "").trim();
    const slippageBps = Number(req.body?.slippageBps ?? 100);

    if (!isEvmAddress(fromToken)) throw new Error("fromToken must be 0x address");
    if (!isEvmAddress(toToken)) throw new Error("toToken must be 0x address");
    if (!/^\d+$/.test(fromAmountWei)) throw new Error("fromAmountWei must be integer string");

    const risk = riskGate({
      chain: fromChain,
      amountInHuman: "(wei)",
      slippageBps,
      mode: "bridge",
    });
    if (!risk.ok) return res.status(400).json({ ok: false, error: "risk_blocked", risk });

    const fromAddress = await mem.evm[fromChain].wallet.getAddress();

    // LI.FI quote/route
    const url =
      `https://li.quest/v1/quote?fromChain=${encodeURIComponent(String(CHAIN[fromChain].chainId))}` +
      `&toChain=${encodeURIComponent(String(CHAIN[toChain].chainId))}` +
      `&fromToken=${encodeURIComponent(fromToken)}` +
      `&toToken=${encodeURIComponent(toToken)}` +
      `&fromAmount=${encodeURIComponent(fromAmountWei)}` +
      `&fromAddress=${encodeURIComponent(fromAddress)}` +
      `&slippage=${encodeURIComponent(String(slippageBps / 10000))}`;

    const qRes = await fetch(url);
    const route = await qRes.json();
    if (!qRes.ok) throw new Error(`LI.FI quote error: ${qRes.status} ${JSON.stringify(route).slice(0, 300)}`);

    const txReq = route?.transactionRequest;
    if (!txReq?.to || !txReq?.data) throw new Error("Missing transactionRequest from LI.FI");

    const tx = {
      to: txReq.to,
      data: txReq.data,
      value: txReq.value ? BigInt(txReq.value) : 0n,
    };

    // ✅ SAFE MODE
    if (DRY_RUN) {
      return res.json({
        ok: true,
        dryRun: true,
        mode: MODE,
        note: "Bridge route ready but NOT executed (safe test mode)",
        risk,
        fromChain,
        toChain,
        fromAddress,
        route,
        tx,
      });
    }

    const sent = await mem.evm[fromChain].wallet.sendTransaction(tx);
    await sent.wait();

    return res.json({
      ok: true,
      mode: MODE,
      fromChain,
      toChain,
      hash: sent.hash,
      explorer: `${CHAIN[fromChain].explorer}${sent.hash}`,
      risk,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- Agent router (detect + risk) -------- */
app.post("/api/agent", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.json({
        ok: true,
        route: { intent: "unknown", chain: null },
        risk: { ok: false, issues: ["Empty input"], warnings: [] },
      });
    }

    const has0x = /0x[a-fA-F0-9]{40}/.test(text);
    const maybeSol = isProbablySolAddress(text) || /So11111111111111111111111111111111111111112/.test(text);

    let route;
    try {
      route = await groqParse(text);
    } catch (e) {
      route = {
        intent: "unknown",
        chain: null,
        action: "unknown",
        tokenIn: null,
        tokenOut: null,
        amount: null,
        slippageBps: 100,
        notes: [`Groq parse failed → fallback: ${e.message}`],
      };
    }

    if (!route.chain) {
      if (maybeSol) route.chain = "sol";
      else if (has0x) route.chain = "base"; // default evm chain
    }

    const slip = Math.min(500, Math.max(10, Number(route.slippageBps || 100)));
    route.slippageBps = slip;

    const mode = route.intent === "bridge" ? "bridge" : "swap";
    const amountGuess = route.amount || "0";

    const risk = riskGate({
      chain: route.chain || "unknown",
      amountInHuman: amountGuess,
      slippageBps: slip,
      mode,
    });

    if (route.intent === "swap" && route.chain && route.chain !== "sol" && route.tokenOut && isEvmAddress(route.tokenOut)) {
      risk.warnings.push("Unknown EVM token address — could be honeypot/tax/blacklist. Verify contract + liquidity.");
    }

    res.json({ ok: true, mode: MODE, dryRun: DRY_RUN, route, risk });
  } catch (e) {
    res.status(500).json({ ok: false, error: "agent_failed", message: String(e?.message || e) });
  }
});

/* ===== START ===== */
app.listen(PORT, HOST, () => {
  console.log(`✅ API up: http://${HOST}:${PORT}`);
  console.log(`🔐 Tip: keep HOST=127.0.0.1 for safety. Use SSH tunnel if you need access from phone.`);
});
