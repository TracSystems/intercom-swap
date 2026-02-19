export function validateAmount(a) {
  if (!a || Number(a) <= 0) throw new Error("Invalid amount");
}

export function validateSlippage(s) {
  if (s > 500) throw new Error("Slippage too high");
}
