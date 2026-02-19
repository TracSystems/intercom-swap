import { step, info } from "../core/logger.js";
import { groqParse } from "../core/groq.js";
import { isEvmAddressLike, isSolanaMintLike } from "../core/tokens.js";

// ---------- helpers ----------
function normToken(t) {
  if (!t) return null;
  const v = String(t).trim();

  // If CA/mint/address, keep as-is
  if (isEvmAddressLike(v) || isSolanaMintLike(v)) return v;

  // Otherwise treat as symbol
  return v.toUpperCase();
}

function clampSlippageBps(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 50;
  if (x < 1) return 1;
  if (x > 500) return 500;
  return Math.round(x);
}

function parseSlippageBps(prompt) {
  const p = prompt.toLowerCase();

  // "slippage 0.5%" or "slip 1%"
  const mPct = p.match(/slipp(?:age)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (mPct) return clampSlippageBps(Number(mPct[1]) * 100);

  // "slippage 50 bps"
  const mBps = p.match(/slipp(?:age)?\s*([0-9]{1,4})\s*bps/i);
  if (mBps) return clampSlippageBps(Number(mBps[1]));

  // "50 bps" anywhere
  const mBps2 = p.match(/\b([0-9]{1,4})\s*bps\b/i);
  if (mBps2) return clampSlippageBps(Number(mBps2[1]));

  return 50;
}

function parseChain(prompt) {
  const p = prompt.toLowerCase();
  if (p.includes(" base ")) return "base";
  if (p.includes("base")) return "base";
  if (p.includes("solana")) return "sol";
  if (p.includes(" sol ")) return "sol";
  if (p.includes("sol ")) return "sol";
  return null;
}

function extractAmount(prompt) {
  // first number in prompt
  const m = prompt.match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? m[1] : null;
}

function extractTokens(prompt) {
  // Support: "swap <amount> <tokenIn> to/ke <tokenOut>"
  // token can be: symbol (USDC) or CA/mint (base58 32..44) or 0x...
  const p = prompt.trim();

  // This regex tries to capture tokenIn and tokenOut around "to/ke"
  const re = /swap\s+[0-9]+(?:\.[0-9]+)?\s+([A-Za-z0-9_.:-]{2,}|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\s+(?:to|ke)\s+([A-Za-z0-9_.:-]{2,}|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/i;
  const m = p.match(re);
  if (m) return { tokenIn: m[1], tokenOut: m[2] };

  // Fallback: scan for CA/mint/0x addresses
  const evm = p.match(/0x[0-9a-fA-F]{40}/g) || [];
  const sol = p.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const addrs = [...evm, ...sol];

  if (addrs.length >= 2) return { tokenIn: addrs[0], tokenOut: addrs[1] };

  // Fallback: scan for symbols and use first two symbols that aren't words
  const words = p
    .replace(/[%(),]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // remove common keywords
  const stop = new Set(["swap", "to", "ke", "slippage", "slip", "on", "chain", "di"]);
  const syms = words.filter((w) => !stop.has(w.toLowerCase()) && !/^[0-9]+(\.[0-9]+)?$/.test(w));

  if (syms.length >= 2) return { tokenIn: syms[0], tokenOut: syms[1] };

  return { tokenIn: null, tokenOut: null };
}

function finalizePlan(plan, prompt) {
  const tokenIn = normToken(plan.tokenIn);
  const tokenOut = normToken(plan.tokenOut);

  // if chain not set, detect from tokens or prompt
  let chain = plan.chain ? String(plan.chain).toLowerCase() : null;
  if (!chain) chain = parseChain(prompt);
  if (!chain) {
    if (isEvmAddressLike(tokenIn) || isEvmAddressLike(tokenOut)) chain = "base";
    else chain = "sol";
  }

  const amount = plan.amount ? String(plan.amount) : extractAmount(prompt);
  const slippageBps = clampSlippageBps(plan.slippageBps ?? parseSlippageBps(prompt));

  return {
    chain,
    tokenIn,
    tokenOut,
    amount,
    slippageBps,
    // keep original prompt for audit/debug (safe)
    prompt
  };
}

// ---------- main ----------
export async function agentScout(input) {
  step("SCOUT");

  // CLI path (already structured)
  if (!input?.prompt) {
    info(`Scout: CLI params mode`);
    return input;
  }

  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("Empty prompt for agent mode");

  // 1) Try Groq (if available) - must return JSON
  const ai = await groqParse(prompt);
  if (ai && typeof ai === "object") {
    const plan = finalizePlan(ai, prompt);
    info(`Scout(Groq): chain=${plan.chain}, in=${plan.tokenIn}, out=${plan.tokenOut}, amount=${plan.amount}, slippageBps=${plan.slippageBps}`);
    return plan;
  }

  // 2) Fallback parser (robust regex)
  const chain = parseChain(prompt);
  const amount = extractAmount(prompt);
  const { tokenIn, tokenOut } = extractTokens(prompt);
  const slippageBps = parseSlippageBps(prompt);

  const plan = finalizePlan({ chain, tokenIn, tokenOut, amount, slippageBps }, prompt);
  info(`Scout(Fallback): chain=${plan.chain}, in=${plan.tokenIn}, out=${plan.tokenOut}, amount=${plan.amount}, slippageBps=${plan.slippageBps}`);

  // Hard fail if still missing core fields
  if (!plan.tokenIn || !plan.tokenOut || !plan.amount) {
    throw new Error(
      `Scout failed to parse prompt. Try format: "swap 1 USDC to SOL slippage 0.5%" or use CA directly.`
    );
  }

  return plan;
}
