import readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) => new Promise((res) => rl.question(q, (ans) => res(ans.trim())));
const pretty = (x) => console.log(JSON.stringify(x, null, 2));

let BASE_URL = process.env.CLI_BASE_URL || "http://127.0.0.1:3000";
let API_KEY = process.env.API_KEY || "";

function mask(v){
  if(!v) return "(empty)";
  return "********";
}

async function api(path, { method="GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function menu() {
  console.log("\n=== IntercomSwap ProMax — CLI ===");
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`API Key  : ${mask(API_KEY)}`);
  console.log(`
[1] Health
[2] Set API Key
[3] Generate SOL Wallet
[4] Set SOL Wallet (paste secret)
[5] SOL Balance
[6] SOL Swap Execute

[7] Generate EVM Wallet
[8] Set EVM Wallet (ETH/BSC/BASE)
[9] EVM Balance
[10] EVM Swap Execute (0x)

[11] Bridge Execute (EVM↔EVM via LI.FI)
[12] Agent Analyze (Detect + Risk)

[13] Change Base URL (private/public)
[0] Exit
`);
}

async function run() {
  while (true) {
    await menu();
    const pick = await ask("Choose: ");

    if (pick === "0") break;

    if (pick === "1") {
      pretty(await api("/api/health"));
    }

    if (pick === "2") {
      API_KEY = await ask("API Key: ");
      console.log("OK (masked).");
    }

    if (pick === "3") {
      const r = await api("/api/gen/sol", { method:"POST" });
      pretty(r);
      if (r.data?.secretJson) {
        console.log("\nSOL Secret JSON (copy & save safely):");
        console.log(r.data.secretJson);
      }
    }

    if (pick === "4") {
      const secret = await ask("Paste SOL secret (JSON/base58): ");
      pretty(await api("/api/wallet/sol", { method:"POST", body:{ secret } }));
    }

    if (pick === "5") {
      pretty(await api("/api/sol/balance"));
    }

    if (pick === "6") {
      const inputMint = await ask("inputMint (wSOL mint default So111...): ");
      const outputMint = await ask("outputMint: ");
      const amountLamports = await ask("amountLamports (e.g. 10000000): ");
      const slippageBps = await ask("slippageBps (e.g. 100): ");
      pretty(await api("/api/sol/swap", {
        method:"POST",
        body:{ inputMint, outputMint, amountLamports, slippageBps: Number(slippageBps || 100) }
      }));
    }

    if (pick === "7") {
      const r = await api("/api/gen/evm", { method:"POST" });
      pretty(r);
      if (r.data?.privateKey) {
        console.log("\nEVM PrivateKey (copy & save safely):");
        console.log(r.data.privateKey);
      }
    }

    if (pick === "8") {
      const chain = (await ask("chain (eth/bsc/base): ")).toLowerCase();
      const privateKey = await ask("privateKey (0x...): ");
      pretty(await api("/api/wallet/evm", { method:"POST", body:{ chain, privateKey } }));
    }

    if (pick === "9") {
      const chain = (await ask("chain (eth/bsc/base): ")).toLowerCase();
      pretty(await api(`/api/evm/balance?chain=${encodeURIComponent(chain)}`));
    }

    if (pick === "10") {
      const chain = (await ask("chain (eth/bsc/base): ")).toLowerCase();
      const sellToken = await ask("sellToken (0x.. or ETH/BNB): ");
      const buyToken = await ask("buyToken (0x.. or ETH/BNB): ");
      const sellAmountWei = await ask("sellAmountWei (integer): ");
      const slippageBps = await ask("slippageBps (e.g. 100): ");
      pretty(await api("/api/evm/swap", {
        method:"POST",
        body:{ chain, sellToken, buyToken, sellAmountWei, slippageBps: Number(slippageBps || 100) }
      }));
    }

    if (pick === "11") {
      const fromChain = (await ask("fromChain (eth/bsc/base): ")).toLowerCase();
      const toChain = (await ask("toChain (eth/bsc/base): ")).toLowerCase();
      const fromToken = await ask("fromToken (0x..): ");
      const toToken = await ask("toToken (0x..): ");
      const fromAmountWei = await ask("fromAmountWei (integer): ");
      const slippageBps = await ask("slippageBps (e.g. 100): ");
      pretty(await api("/api/bridge/evm", {
        method:"POST",
        body:{ fromChain, toChain, fromToken, toToken, fromAmountWei, slippageBps: Number(slippageBps || 100) }
      }));
    }

    if (pick === "12") {
      const text = await ask("Agent text: ");
      pretty(await api("/api/agent", { method:"POST", body:{ text } }));
    }

    if (pick === "13") {
      BASE_URL = await ask("New BASE_URL (e.g. http://127.0.0.1:3000): ");
      console.log("OK.");
    }
  }

  rl.close();
}

run();
