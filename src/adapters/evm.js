import { ethers } from "ethers";
import { httpJson } from "../core/http.js";
import dotenv from "dotenv";

dotenv.config();

export async function evmSwap(input) {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
  const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);

  const quote = await httpJson(`https://api.0x.org/swap/v1/quote?sellToken=${input.tokenIn}&buyToken=${input.tokenOut}&sellAmount=${ethers.parseUnits(input.amount, 6)}`);

  const tx = await wallet.sendTransaction({
    to: quote.to,
    data: quote.data,
    value: BigInt(quote.value || 0)
  });

  return { txid: tx.hash, quote };
}
