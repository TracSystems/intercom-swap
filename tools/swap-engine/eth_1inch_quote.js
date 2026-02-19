const fetch = require("node-fetch");

// Read-only quote via 1inch (Ethereum mainnet by default)
module.exports = async function inchQuote(sellToken, buyToken, sellAmount, chainId = 1) {
  if (!sellToken || !buyToken || !sellAmount) {
    throw new Error("Missing params: sellToken, buyToken, sellAmount");
  }

  // Common symbol → address mapping for Mainnet
  const map = {
    ETH:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI:  "0x6B175474E89094C44Da98b954EedeAC495271d0F"
  };

  const from = map[String(sellToken).toUpperCase()] || sellToken;
  const to   = map[String(buyToken).toUpperCase()]  || buyToken;

  const url = new URL(`https://api.1inch.io/v5.0/${chainId}/quote`);
  url.searchParams.set("fromTokenAddress", from);
  url.searchParams.set("toTokenAddress", to);
  url.searchParams.set("amount", String(sellAmount));

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`1inch quote failed (${r.status}): ${JSON.stringify(data).slice(0, 300)}`);

  return {
    fromToken: data.fromToken,
    toToken: data.toToken,
    fromAmount: data.fromAmount,
    toAmount: data.toAmount,
    estimatedGas: data.estimatedGas
  };
};
