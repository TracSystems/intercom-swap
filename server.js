import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bs58 from 'bs58';
import { ethers } from 'ethers';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const API_KEY = process.env.API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';

const RPC_ETH = process.env.EVM_RPC_ETH || '';
const RPC_BSC = process.env.EVM_RPC_BSC || '';
const RPC_BASE = process.env.EVM_RPC_BASE || '';
const SOL_RPC = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || '';

const CHAIN = {
  eth: { chainId: 1, name: 'Ethereum', rpc: RPC_ETH, native: 'ETH' },
  bsc: { chainId: 56, name: 'BSC', rpc: RPC_BSC, native: 'BNB' },
  base: { chainId: 8453, name: 'Base', rpc: RPC_BASE, native: 'ETH' }
};

function requireApiKey(req) {
  if (!API_KEY) return true; // if not set, allow (not recommended)
  const k = req.headers['x-api-key'];
  return k && k === API_KEY;
}

function maskAddr(a) {
  if (!a) return null;
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isEvmAddress(x) {
  return typeof x === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x.trim());
}

function isProbablySolAddress(x) {
  return typeof x === 'string' && x.trim().length >= 32 && x.trim().length <= 50 && !x.trim().startsWith('0x');
}

function parseSolSecret(input) {
  const s = (input || '').trim();
  if (!s) throw new Error('Empty SOL secret');
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('Invalid JSON array');
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const bytes = bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

function parseEvmPk(input) {
  const s = (input || '').trim();
  if (!s) throw new Error('Empty EVM private key');
  const pk = s.startsWith('0x') ? s : `0x${s}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) throw new Error('Invalid EVM private key format');
  return pk;
}

// RAM-only wallets
const mem = {
  sol: { kp: null, address: null },
  evm: {
    eth: { wallet: null, address: null },
    bsc: { wallet: null, address: null },
    base: { wallet: null, address: null }
  }
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

  if (!Number.isFinite(amt) || amt <= 0) issues.push('Amount must be > 0');
  if (!Number.isFinite(slip) || slip <= 0) warnings.push('Slippage not set/invalid. Try 50–150 bps.');
  if (slip > 300) warnings.push('High slippage (>3%) — higher MEV/sandwich risk.');

  if (chain === 'sol' && amt >= 1) warnings.push('Large SOL amount — start small, use burner wallet.');
  if ((chain === 'eth' || chain === 'base') && amt >= 0.2) warnings.push('Large amount — do a tiny test tx first.');
  if (chain === 'bsc' && amt >= 1) warnings.push('Large amount — do a tiny test tx first.');

  if (mode === 'bridge') warnings.push('Bridge risk: route failures/delays/extra fees.');

  return { ok: issues.length === 0, issues, warnings };
}

async function groqParse(userText) {
  if (!GROQ_API_KEY) {
    return {
      intent: 'unknown',
      chain: null,
      action: null,
      tokenIn: null,
      tokenOut: null,
      amount: null,
      slippageBps: 100,
      notes: ['GROQ_API_KEY not set — fallback detectors only.']
    };
  }

  const sys = `Return ONLY valid JSON with keys:
intent: "swap"|"bridge"|"balance"|"status"|"help"|"unknown"
chain: "sol"|"eth"|"bsc"|"base"|null
tokenIn: string|null
tokenOut: string|null
amount: string|null
slippageBps: number
action: "execute_swap"|"execute_bridge"|"show_balance"|"quote"|"unknown"
notes: array of strings
Rules:
- If you see 0x... address, assume EVM token.
- If you see Solana mint/address, assume sol.
- If chain missing for EVM, set chain null.
- slippageBps clamp 10..500
No extra text.`;

  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userText }
    ],
    temperature: 0.2
  };

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Groq error: ${r.status} ${t}`);
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content?.trim() || '';
  return JSON.parse(content);
}

/* ================= API ================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    apiKeyEnabled: !!API_KEY,
    groq: !!GROQ_API_KEY,
    rpc: {
      sol: SOL_RPC,
      eth: !!RPC_ETH,
      bsc: !!RPC_BSC,
      base: !!RPC_BASE
    },
    wallets: {
      sol: !!mem.sol.kp,
      eth: !!mem.evm.eth.wallet,
      bsc: !!mem.evm.bsc.wallet,
      base: !!mem.evm.base.wallet
    }
  });
});

/* -------- Generate burner wallets (server-side) -------- */
app.post('/api/gen/sol', (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const kp = Keypair.generate();
    res.json({
      ok: true,
      address: kp.publicKey.toBase58(),
      secretJson: JSON.stringify(Array.from(kp.secretKey)),
      secretBase58: bs58.encode(kp.secretKey)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/gen/evm', (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const w = ethers.Wallet.createRandom();
    res.json({
      ok: true,
      address: w.address,
      privateKey: w.privateKey
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- Wallet setup -------- */
app.post('/api/wallet/sol', (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const kp = parseSolSecret(req.body?.secret);
    mem.sol.kp = kp;
    mem.sol.address = kp.publicKey.toBase58();
    res.json({ ok: true, address: mem.sol.address, addressMasked: maskAddr(mem.sol.address) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/wallet/evm', async (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const chain = String(req.body?.chain || '').toLowerCase();
    if (!CHAIN[chain]) throw new Error('Invalid chain (use eth/bsc/base)');
    const pk = parseEvmPk(req.body?.privateKey);
    const provider = getProvider(chain);
    const wallet = new ethers.Wallet(pk, provider);

    mem.evm[chain].wallet = wallet;
    mem.evm[chain].address = await wallet.getAddress();

    res.json({
      ok: true,
      chain,
      address: mem.evm[chain].address,
      addressMasked: maskAddr(mem.evm[chain].address)
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* -------- Agent router (detect + risk) -------- */
app.post('/api/agent', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.json({
        ok: true,
        route: { intent: 'unknown', chain: null },
        risk: { ok: false, issues: ['Empty input'], warnings: [] }
      });
    }

    const has0x = /0x[a-fA-F0-9]{40}/.test(text);
    const maybeSol = isProbablySolAddress(text) || /So11111111111111111111111111111111111111112/.test(text);

    let route;
    try {
      route = await groqParse(text);
    } catch (e) {
      route = {
        intent: 'unknown',
        chain: null,
        action: null,
        tokenIn: null,
        tokenOut: null,
        amount: null,
        slippageBps: 100,
        notes: [`Groq parse failed → fallback: ${e.message}`]
      };
    }

    // Force chain inference if obvious
    if (!route.chain) {
      if (maybeSol) route.chain = 'sol';
      else if (has0x) route.chain = 'base'; // default to BASE (as you wanted)
    }

    // Clamp slippage
    const slip = Math.min(500, Math.max(10, Number(route.slippageBps || 100)));
    route.slippageBps = slip;

    // Decide mode for risk
    const mode = route.intent === 'bridge' ? 'bridge' : 'swap';
    const amountGuess = route.amount || '0';

    const risk = riskGate({
      chain: route.chain || 'unknown',
      amountInHuman: amountGuess,
      slippageBps: slip,
      mode
    });

    // Extra warnings if token looks unknown/suspicious
    if (route.intent === 'swap' && route.chain && route.chain !== 'sol' && route.tokenOut && isEvmAddress(route.tokenOut)) {
      risk.warnings.push('Unknown EVM token address — could be honeypot/tax/blacklist. Verify before executing.');
    }

    res.json({ ok: true, route, risk });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= SOL (Jupiter Execute) ================= */

app.get('/api/sol/balance', async (req, res) => {
  try {
    if (!mem.sol.kp) return res.status(400).json({ ok: false, error: 'SOL wallet not set' });
    const conn = new Connection(SOL_RPC, 'confirmed');
    const lamports = await conn.getBalance(mem.sol.kp.publicKey);
    res.json({ ok: true, address: mem.sol.address, lamports, sol: lamports / 1e9 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sol/swap', async (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    if (!mem.sol.kp) throw new Error('SOL wallet not set');

    const { inputMint, outputMint, amountLamports, slippageBps } = req.body || {};
    if (!inputMint || !outputMint) throw new Error('Missing mint(s)');
    const amount = String(amountLamports || '').trim();
    if (!/^\d+$/.test(amount)) throw new Error('amountLamports must be integer string');
    const slip = Math.min(500, Math.max(10, Number(slippageBps || 100)));

    const human = (Number(amount) / 1e9).toString();
    const risk = riskGate({ chain: 'sol', amountInHuman: human, slippageBps: slip, mode: 'swap' });
    if (!risk.ok) return res.status(400).json({ ok: false, error: 'Risk gate failed', risk });

    const qUrl = new URL('https://quote-api.jup.ag/v6/quote');
    qUrl.searchParams.set('inputMint', inputMint);
    qUrl.searchParams.set('outputMint', outputMint);
    qUrl.searchParams.set('amount', amount);
    qUrl.searchParams.set('slippageBps', String(slip));

    const qRes = await fetch(qUrl.toString());
    const quote = await qRes.json();
    if (!qRes.ok) throw new Error(`Jupiter quote failed: ${JSON.stringify(quote)}`);

    const sRes = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: mem.sol.address,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      })
    });
    const swapJson = await sRes.json();
    if (!sRes.ok) throw new Error(`Jupiter swap build failed: ${JSON.stringify(swapJson)}`);

    const txBuf = Buffer.from(swapJson.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([mem.sol.kp]);

    const conn = new Connection(SOL_RPC, 'confirmed');
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction(sig, 'confirmed');

    res.json({ ok: true, chain: 'sol', signature: sig, confirmation: conf, risk });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ================= EVM SWAP (0x Execute) ================= */

async function zeroXQuote({ chainKey, sellToken, buyToken, sellAmountWei, slippageBps }) {
  const c = CHAIN[chainKey];
  if (!c) throw new Error('Invalid chain');
  const url = new URL('https://api.0x.org/swap/v1/quote');
  url.searchParams.set('chainId', String(c.chainId));
  url.searchParams.set('sellToken', sellToken);
  url.searchParams.set('buyToken', buyToken);
  url.searchParams.set('sellAmount', sellAmountWei);

  const slipPct = Math.min(0.05, Math.max(0.001, Number(slippageBps || 100) / 10000));
  url.searchParams.set('slippagePercentage', String(slipPct));

  const headers = { 'content-type': 'application/json' };
  if (ZEROX_API_KEY) headers['0x-api-key'] = ZEROX_API_KEY;

  const r = await fetch(url.toString(), { headers });
  const j = await r.json();
  if (!r.ok) throw new Error(`0x quote failed: ${JSON.stringify(j)}`);
  return j;
}

app.get('/api/evm/balance', async (req, res) => {
  try {
    const chain = String(req.query.chain || '').toLowerCase();
    if (!CHAIN[chain]) throw new Error('Invalid chain');
    const w = mem.evm[chain].wallet;
    if (!w) throw new Error(`EVM wallet not set for ${chain}`);
    const bal = await w.provider.getBalance(await w.getAddress());
    res.json({ ok: true, chain, address: mem.evm[chain].address, nativeWei: bal.toString(), native: ethers.formatEther(bal) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/evm/swap', async (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const { chain, sellToken, buyToken, sellAmountWei, slippageBps } = req.body || {};
    const chainKey = String(chain || '').toLowerCase();
    if (!CHAIN[chainKey]) throw new Error('Invalid chain (eth/bsc/base)');
    const wallet = mem.evm[chainKey].wallet;
    if (!wallet) throw new Error(`EVM wallet not set for ${chainKey}`);

    if (!sellToken || !buyToken) throw new Error('Missing token(s)');
    if (!/^\d+$/.test(String(sellAmountWei || ''))) throw new Error('sellAmountWei must be integer string');

    const slip = Math.min(500, Math.max(10, Number(slippageBps || 100)));

    // Basic risk gate (slippage focused; wei-human depends on decimals)
    const risk = riskGate({ chain: chainKey, amountInHuman: '0.1', slippageBps: slip, mode: 'swap' });
    if (!risk.ok) return res.status(400).json({ ok: false, error: 'Risk gate failed', risk });

    const quote = await zeroXQuote({
      chainKey,
      sellToken,
      buyToken,
      sellAmountWei: String(sellAmountWei),
      slippageBps: slip
    });

    // Approve if ERC20 sell
    const isNativeSell = (sellToken || '').toUpperCase() === 'ETH' || (sellToken || '').toUpperCase() === 'BNB';
    if (!isNativeSell && isEvmAddress(sellToken)) {
      const erc20 = new ethers.Contract(
        sellToken,
        [
          'function allowance(address owner, address spender) view returns (uint256)',
          'function approve(address spender, uint256 value) returns (bool)'
        ],
        wallet
      );
      const owner = await wallet.getAddress();
      const spender = quote.allowanceTarget;
      const allowance = await erc20.allowance(owner, spender);
      const need = BigInt(quote.sellAmount);
      if (BigInt(allowance.toString()) < need) {
        const txa = await erc20.approve(spender, need);
        await txa.wait();
      }
    }

    const tx = await wallet.sendTransaction({
      to: quote.to,
      data: quote.data,
      value: quote.value ? BigInt(quote.value) : 0n,
      gasLimit: quote.gas ? BigInt(quote.gas) : undefined
    });
    const receipt = await tx.wait();

    res.json({
      ok: true,
      chain: chainKey,
      hash: tx.hash,
      receipt: { status: receipt.status, blockNumber: receipt.blockNumber },
      risk
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ================= BRIDGE (EVM↔EVM via LI.FI) ================= */

app.post('/api/bridge/evm', async (req, res) => {
  if (!requireApiKey(req)) return res.status(401).json({ ok: false, error: 'Unauthorized (x-api-key)' });
  try {
    const { fromChain, toChain, fromToken, toToken, fromAmountWei, slippageBps } = req.body || {};
    const a = String(fromChain || '').toLowerCase();
    const b = String(toChain || '').toLowerCase();
    if (!CHAIN[a] || !CHAIN[b]) throw new Error('Bridge supports only eth/bsc/base');
    if (!/^\d+$/.test(String(fromAmountWei || ''))) throw new Error('fromAmountWei must be integer string');

    const wallet = mem.evm[a].wallet;
    if (!wallet) throw new Error(`EVM wallet not set for ${a}`);

    const slip = Math.min(500, Math.max(10, Number(slippageBps || 100)));
    const risk = riskGate({ chain: a, amountInHuman: '0.1', slippageBps: slip, mode: 'bridge' });
    if (!risk.ok) return res.status(400).json({ ok: false, error: 'Risk gate failed', risk });

    const rUrl = new URL('https://li.quest/v1/quote');
    rUrl.searchParams.set('fromChain', String(CHAIN[a].chainId));
    rUrl.searchParams.set('toChain', String(CHAIN[b].chainId));
    rUrl.searchParams.set('fromToken', fromToken);
    rUrl.searchParams.set('toToken', toToken);
    rUrl.searchParams.set('fromAmount', String(fromAmountWei));
    rUrl.searchParams.set('fromAddress', await wallet.getAddress());
    rUrl.searchParams.set('slippage', String(Math.min(0.05, Math.max(0.001, slip / 10000))));

    const q = await fetch(rUrl.toString());
    const quote = await q.json();
    if (!q.ok) throw new Error(`LI.FI quote failed: ${JSON.stringify(quote)}`);

    const txReq = quote?.transactionRequest;
    if (!txReq?.to || !txReq?.data) throw new Error('LI.FI missing transactionRequest');

    // approve if ERC20
    if (isEvmAddress(fromToken) && quote?.estimate?.approvalAddress) {
      const erc20 = new ethers.Contract(
        fromToken,
        ['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 value) returns (bool)'],
        wallet
      );
      const owner = await wallet.getAddress();
      const spender = quote.estimate.approvalAddress;
      const allowance = await erc20.allowance(owner, spender);
      const need = BigInt(fromAmountWei);
      if (BigInt(allowance.toString()) < need) {
        const txa = await erc20.approve(spender, need);
        await txa.wait();
      }
    }

    const tx = await wallet.sendTransaction({
      to: txReq.to,
      data: txReq.data,
      value: txReq.value ? BigInt(txReq.value) : 0n
    });
    const receipt = await tx.wait();

    res.json({
      ok: true,
      mode: 'bridge',
      fromChain: a,
      toChain: b,
      hash: tx.hash,
      receipt: { status: receipt.status, blockNumber: receipt.blockNumber },
      risk,
      note: 'Bridge finality depends on route. Track on explorer / LI.FI.'
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ================= start ================= */

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`RUNNING http://${HOST}:${PORT}`);
});
