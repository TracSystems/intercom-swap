import { step } from "../core/logger.js";

export function agentAnalyst(input) {
  step("ANALYST");

  if (!input.chain) {
    input.chain = input.tokenIn?.startsWith("0x") ? "base" : "sol";
  }

  return input;
}
