import { step, info } from "../core/logger.js";
import { isEvmAddressLike, isSolanaMintLike } from "../core/tokens.js";
import { fetchDexTokenPairs, pickBestPair, normalizePair } from "../core/dexscreener.js";

/**
 * Analyst:
 * - Auto-detect chain from CA
 * - Fetch Dexscreener market snapshot (best pair by liquidity)
 * - Attach market info to input as `market` (for riskgate & final output)
 */
export async function agentAnalyst(input) {
  step("ANALYST");

  if (!input.tokenIn || !input.tokenOut) {
    throw new Error("Token missing (tokenIn/tokenOut)");
  }

  const tokenIn = String(input.tokenIn).trim();
  const tokenOut = String(input.tokenOut).trim();

  // auto chain detection if not provided
  let chain = input.chain ? String(input.chain).toLowerCase() : null;
  if (!chain) {
    if (isEvmAddressLike(tokenIn) || isEvmAddressLike(tokenOut)) chain = "base";
    else if (isSolanaMintLike(tokenIn) || isSolanaMintLike(tokenOut)) chain = "sol";
    else chain = "sol";
  }

  const out = { ...input, chain, tokenIn, tokenOut };

  // Pull Dexscreener snapshot IF tokenOut looks like CA/mint (or tokenIn), helpful for risk analysis
  // We try tokenOut first (the thing you are buying), then tokenIn fallback.
  const probeAddr = isEvmAddressLike(tokenOut) || isSolanaMintLike(tokenOut)
    ? tokenOut
    : (isEvmAddressLike(tokenIn) || isSolanaMintLike(tokenIn) ? tokenIn : null);

  if (!probeAddr) {
    info("Analyst: token not a CA/mint -> skip Dexscreener snapshot (symbol mode)");
    return out;
  }

  try {
    info(`Analyst: fetching Dexscreener pairs for ${probeAddr} ...`);
    const pairs = await fetchDexTokenPairs(probeAddr);
    const best = pickBestPair(pairs, { chain });
    const snap = normalizePair(best);

    out.market = {
      source: "dexscreener",
      tokenAddress: probeAddr,
      bestPair: snap
    };

    if (snap) {
      info(`Analyst: best pair ${snap.dex} liquidity=$${Math.round(snap.liquidityUsd)} 24hVol=$${Math.round(snap.volume24hUsd)}`);
    } else {
      info("Analyst: no matching pair found on Dexscreener for this chain");
    }

    return out;
  } catch (e) {
    // Don't hard-fail if Dexscreener down; riskgate can still run basic checks
    info(`Analyst: Dexscreener fetch failed (non-fatal): ${e.message}`);
    return out;
  }
}
