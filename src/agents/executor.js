import { step } from "../core/logger.js";
import { solSwap } from "../adapters/solana.js";
import { evmSwap } from "../adapters/evm.js";

export async function agentExecutor(input, opts = {}) {
  step("EXECUTOR");

  if (opts.dryRun) return { txid: null, quote: {} };

  if (input.chain === "sol") return await solSwap(input);
  if (input.chain === "base") return await evmSwap(input);

  throw new Error("Unsupported chain");
}
