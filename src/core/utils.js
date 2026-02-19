import bs58 from "bs58";

export function parseSolKey(pk) {
  if (pk.startsWith("[")) return Uint8Array.from(JSON.parse(pk));
  return bs58.decode(pk);
}
