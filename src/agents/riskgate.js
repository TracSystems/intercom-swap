import { step } from "../core/logger.js";
import { validateAmount, validateSlippage } from "../core/validation.js";

export function agentRiskGate(input) {
  step("RISK");

  validateAmount(input.amount);
  validateSlippage(input.slippageBps);

  return input;
}
