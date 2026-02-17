async function runAI() {
  const token = document.getElementById("token").value;

  const res = await fetch("/ai", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ token })
  });

  const data = await res.json();

  document.getElementById("output").innerText =
    "AI: " + data.decision;
}

async function swap() {
  const res = await fetch("/swap-evm", { method: "POST" });
  const data = await res.json();

  document.getElementById("output").innerText =
    "TX: " + (data.tx || data.error);
}

async function getBalance() {
  const res = await fetch("/balance");
  const data = await res.json();

  document.getElementById("output").innerText =
    `EVM: ${data.evm} ETH | SOL: ${data.sol}`;
}

async function trending() {
  const res = await fetch("/trending");
  const data = await res.json();

  document.getElementById("output").innerText =
    "🔥 " + data[0].baseToken.symbol;
}

async function autoTrade() {
  const res = await fetch("/auto-trade", { method: "POST" });
  const data = await res.json();

  document.getElementById("output").innerText =
    "AI Decision: " + data.decision;
}
