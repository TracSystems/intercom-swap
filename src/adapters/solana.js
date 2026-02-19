import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { httpJson } from "../core/http.js";
import { parseSolKey } from "../core/utils.js";
import dotenv from "dotenv";

dotenv.config();

export async function solSwap(input) {
  const wallet = Keypair.fromSecretKey(parseSolKey(process.env.SOL_PRIVATE_KEY));
  const conn = new Connection(process.env.SOL_RPC);

  const quote = await httpJson(`https://api.jup.ag/swap/v1/quote?inputMint=${input.tokenIn}&outputMint=${input.tokenOut}&amount=${input.amount}&slippageBps=${input.slippageBps}`);

  const swap = await httpJson("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString()
    }),
    headers: { "Content-Type": "application/json" }
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([wallet]);

  const sig = await conn.sendRawTransaction(tx.serialize());
  return { txid: sig, quote };
}
