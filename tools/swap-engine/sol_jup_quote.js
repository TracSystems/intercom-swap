const fetch = require("node-fetch");

// Jupiter quote (read-only)
module.exports = async function jupQuote(inputMint, outputMint, amount, slippageBps = 50) {
  if (!inputMint || !outputMint || !amount) {
    throw new Error("Missing params: inputMint, outputMint, amount");
  }

  const url = new URL("https://quote-api.jup.ag/v6/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", String(slippageBps));

  const r = await fetch(url.toString());
  const data = await r.json();
  if (!r.ok) throw new Error(`Jupiter quote failed (${r.status}): ${JSON.stringify(data).slice(0, 300)}`);

  const route = data?.data?.[0];
  return {
    inAmount: route?.inAmount,
    outAmount: route?.outAmount,
    priceImpactPct: route?.priceImpactPct,
    marketInfos: (route?.marketInfos || []).slice(0, 8),
  };
};
