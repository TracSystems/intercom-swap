import { step, info } from "../core/logger.js";
import { isEvmAddressLike, isSolanaMintLike } from "../core/tokens.js";
import { fetchDexTokenPairs, pickBestPair, normalizePair } from "../core/dexscreener.js";

export async function agentAnalyst(input) {
  step("ANALYST");

  if (!input.tokenIn || !input.tokenOut) {
    throw new Error("Token missing (tokenIn/tokenOut)");
  }

  const tokenIn = String(input.tokenIn).trim();
  const tokenOut = String(input.tokenOut).trim();

  // auto chain detect if not provided
  let chain = input.chain ? String(input.chain).toLowerCase() : null;
  if (!chain) {
    if (isEvmAddressLike(tokenIn) || isEvmAddressLike(tokenOut)) chain = "base";
    else if (isSolanaMintLike(tokenIn) || isSolanaMintLike(tokenOut)) chain = "sol";
    else chain = "sol";
  }

  const out = { ...input, chain, tokenIn, tokenOut };

  // Dexscreener only makes sense if user provided a CA/mint/0x
  const probeAddr =
    isEvmAddressLike(tokenOut) || isSolanaMintLike(tokenOut)
      ? tokenOut
      : (isEvmAddressLike(tokenIn) || isSolanaMintLike(tokenIn) ? tokenIn : null);

  if (!probeAddr) {
    info("Analyst: symbol mode (no CA) -> skip Dexscreener snapshot");
    return out;
  }

  try {
    info(`Analyst: Dexscreener lookup for ${probeAddr} ...`);
    const pairs = await fetchDexTokenPairs(probeAddr);
    const best = pickBestPair(pairs, { chain });
    const snap = normalizePair(best);

    out.market = {
      source: "dexscreener",
      tokenAddress: probeAddr,
      bestPair: snap
    };

    if (snap) {
      info(`Analyst: bestPair dex=${snap.dex} liq=$${Math.round(snap.liquidityUsd || 0)} vol24=$${Math.round(snap.volume24hUsd || 0)}`);
    } else {
      info("Analyst: no chain-matching pair found on Dexscreener");
    }

    return out;
  } catch (e) {
    info(`Analyst: Dexscreener failed (non-fatal): ${e.message}`);
    return out;
  }
}
