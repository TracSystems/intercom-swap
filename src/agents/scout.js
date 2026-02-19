import { step } from "../core/logger.js";
import { groqParse } from "../core/groq.js";

function fallback(p) {
  const amt = p.match(/\d+/)?.[0];
  return {
    chain: "sol",
    tokenIn: "USDC",
    tokenOut: "SOL",
    amount: amt,
    slippageBps: 50
  };
}

export async function agentScout(input) {
  step("SCOUT");

  if (input.prompt) {
    const ai = await groqParse(input.prompt);
    return ai || fallback(input.prompt);
  }

  return input;
}
