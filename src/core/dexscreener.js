import { httpJson } from "./http.js";

const DEX_BASE = "https://api.dexscreener.com/latest/dex/tokens";

/**
 * Dexscreener chains that are commonly used in pair objects:
 * - Solana: "solana"
 * - Base: "base"
 */
export function toDexChain(chain) {
  const c = (chain || "").toLowerCase();
  if (c === "sol") return "solana";
  if (c === "base") return "base";
  return c;
}

/**
 * Fetch all pairs for a token address (CA / mint / 0x address).
 * Returns array of pair objects (can be empty).
 */
export async function fetchDexTokenPairs(tokenAddress) {
  if (!tokenAddress) throw new Error("Dexscreener: token address missing");
  const url = `${DEX_BASE}/${encodeURIComponent(tokenAddress.trim())}`;
  const data = await httpJson(url, { method: "GET" });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

/**
 * Pick best pair for a chain (highest liquidity USD),
 * optionally prefer a quote symbol like USDC/USDT/SOL/WETH.
 */
export function pickBestPair(pairs, { chain, preferQuoteSymbols = ["USDC", "USDT", "SOL", "WETH", "ETH"] } = {}) {
  const dexChain = toDexChain(chain);
  const filtered = pairs.filter((p) => (p.chainId || "").toLowerCase() === dexChain);

  if (!filtered.length) return null;

  // prefer quote tokens (e.g. USDC) if available
  const preferred = filtered
    .filter((p) => preferQuoteSymbols.includes((p.quoteToken?.symbol || "").toUpperCase()))
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

  if (preferred.length) return preferred[0];

  // fallback: max liquidity
  return filtered.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

/**
 * Normalize a dex pair into a compact "market snapshot" for risk engine.
 */
export function normalizePair(pair) {
  if (!pair) return null;

  const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : null; // ms epoch
  const ageMs = createdAt ? Date.now() - createdAt : null;

  const snap = {
    dex: pair.dexId || null,
    chainId: pair.chainId || null,
    pairAddress: pair.pairAddress || null,

    base: {
      symbol: pair.baseToken?.symbol || null,
      name: pair.baseToken?.name || null,
      address: pair.baseToken?.address || null
    },
    quote: {
      symbol: pair.quoteToken?.symbol || null,
      name: pair.quoteToken?.name || null,
      address: pair.quoteToken?.address || null
    },

    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : 0,
    fdvUsd: pair.fdv ? Number(pair.fdv) : null,

    volume24hUsd: pair.volume?.h24 ? Number(pair.volume.h24) : 0,
    buys24h: pair.txns?.h24?.buys ? Number(pair.txns.h24.buys) : 0,
    sells24h: pair.txns?.h24?.sells ? Number(pair.txns.h24.sells) : 0,

    priceChange24hPct: pair.priceChange?.h24 ? Number(pair.priceChange.h24) : null,

    createdAt,
    ageMs
  };

  return snap;
}
