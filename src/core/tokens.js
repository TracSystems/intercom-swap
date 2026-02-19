// Token resolver: accept SYMBOL or ADDRESS/CA
// - Solana: mint base58 32..44 chars
// - EVM: 0x address

export const SOLANA_MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  // USDC mainnet
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // USDT mainnet
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
};

export const EVM_TOKENS = {
  base: {
    // Base mainnet
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006"
  }
};

export function isSolanaMintLike(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

export function isEvmAddressLike(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

export function resolveSolanaMint(symOrAddr) {
  if (!symOrAddr) throw new Error("Missing token");
  const v = symOrAddr.trim();

  if (isSolanaMintLike(v)) return v;

  const k = v.toUpperCase();
  if (SOLANA_MINTS[k]) return SOLANA_MINTS[k];

  throw new Error(`Unsupported SOL token/mint: ${symOrAddr}`);
}

export function resolveEvmToken(chain, symOrAddr) {
  if (!symOrAddr) throw new Error("Missing token");
  const v = symOrAddr.trim();

  if (isEvmAddressLike(v)) return v;

  const map = EVM_TOKENS[chain];
  if (!map) throw new Error(`Unsupported EVM chain: ${chain}`);

  const k = v.toUpperCase();
  if (map[k]) return map[k];

  throw new Error(`Unsupported EVM token: ${symOrAddr} (chain=${chain})`);
}
