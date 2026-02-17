import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { ethers, Wallet } from "ethers";
import { Connection } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = 3000;

// ================= CONFIG =================
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const EVM_RPC = "https://rpc.ankr.com/eth";
const SOL_RPC = "https://api.mainnet-beta.solana.com";

const provider = new ethers.JsonRpcProvider(EVM_RPC);
const connection = new Connection(SOL_RPC);

// ================= WALLET =================
let CURRENT_WALLET = null;

// generate wallet
app.get("/generate-wallet", (req, res) => {
  const wallet = Wallet.createRandom();
  CURRENT_WALLET = wallet;

  res.json({
    address: wallet.address,
    privateKey: wallet.privateKey
  });
});

// set wallet from PK
app.post("/set-wallet", (req, res) => {
  const { privateKey } = req.body;

  try {
    const wallet = new Wallet(privateKey, provider);
    CURRENT_WALLET = wallet;

    res.json({ address: wallet.address });
  } catch {
    res.json({ error: "Invalid private key" });
  }
});

// ================= AI =================
async function aiDecision(token) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages: [
        {
          role: "user",
          content: `Analyze ${token}. Answer BUY / SELL / SKIP`
        }
      ]
    })
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ================= BALANCE =================
app.get("/balance", async (req, res) => {
  try {
    if (!CURRENT_WALLET) {
      return res.json({ error: "Set wallet first" });
    }

    const evmBal = await provider.getBalance(CURRENT_WALLET.address);

    res.json({
      address: CURRENT_WALLET.address,
      evm: ethers.formatEther(evmBal)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= SWAP =================
app.post("/swap-evm", async (req, res) => {
  try {
    if (!CURRENT_WALLET) {
      return res.json({ error: "Set wallet first" });
    }

    const r = await fetch("https://li.quest/v1/quote", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        fromChain: 1,
        toChain: 1,
        fromToken: "USDC",
        toToken: "ETH",
        fromAmount: "1000000",
        fromAddress: CURRENT_WALLET.address
      })
    });

    const data = await r.json();
    const tx = data.transactionRequest;

    const txResponse = await CURRENT_WALLET.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value
    });

    res.json({ tx: txResponse.hash });

  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= AUTO TRADE =================
app.post("/auto-trade", async (req, res) => {
  try {
    const decision = await aiDecision("ETH");
    res.json({ decision });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 RUNNING http://localhost:${PORT}`);
});
