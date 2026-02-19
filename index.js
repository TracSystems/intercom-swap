import readline from "readline";

// ===== SHARED UTILS =====
function banner(title) {
  return "\n==============================\n" + title + "\n==============================";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(n) {
  return Number(n).toFixed(4);
}

// ===== AGENT SCOUT =====
async function agentScout({ quoteFn, input }) {
  console.log(banner("🤖 Agent 1: SCOUT (Planner)"));
  console.log("Scout: menerima brief swap…");
  await sleep(250);

  console.log(`Scout: chain=${input.chain}`);
  console.log(`Scout: tokenIn=${input.tokenIn}`);
  console.log(`Scout: tokenOut=${input.tokenOut}`);
  console.log(`Scout: amountIn=${input.amountIn}`);
  console.log(`Scout: slippage=${input.slippageBps} bps`);
  await sleep(250);

  console.log("Scout: fetching quote…");
  const q = await quoteFn(input);
  await sleep(200);

  console.log("Scout: quote received ✅");
  console.log(`Scout: estOut = ${fmt(q.amountOut)}`);
  console.log(`Scout: minOut = ${fmt(q.minOut)}`);
  console.log(`Scout: path   = ${q.path?.join(" -> ") || "-"}`);

  const warnings = [];
  if (input.slippageBps > 300) warnings.push("Slippage > 3% (risky)");
  if (!q.path || q.path.length < 2) warnings.push("Route path invalid");
  if (q.warnings?.length) warnings.push(...q.warnings);

  console.log("\nScout: risk gate report:");
  if (!warnings.length) {
    console.log("Scout: ✅ PASS (no warnings)");
  } else {
    console.log("Scout: ⚠️ WARNINGS:");
    for (const w of warnings) console.log(`- ${w}`);
  }

  const plan = {
    ...input,
    amountOut: q.amountOut,
    minOut: q.minOut,
    path: q.path,
    warnings,
  };

  console.log("\nScout: handoff plan → Executor ✅");
  return plan;
}

// ===== AGENT EXECUTOR =====
function yn(input) {
  const s = String(input || "").trim().toLowerCase();
  return s === "y" || s === "yes";
}

async function agentExecutor({ executeFn, plan, confirmFn }) {
  console.log(banner("🤖 Agent 2: EXECUTOR (Strict)"));
  console.log("Executor: menerima plan dari Scout…");
  await sleep(250);

  console.log("\nExecutor: REVIEW PLAN");
  console.log(`- chain    : ${plan.chain}`);
  console.log(`- tokenIn  : ${plan.tokenIn}`);
  console.log(`- tokenOut : ${plan.tokenOut}`);
  console.log(`- amountIn : ${plan.amountIn}`);
  console.log(`- slippage : ${plan.slippageBps} bps`);
  console.log(`- estOut   : ${fmt(plan.amountOut)}`);
  console.log(`- minOut   : ${fmt(plan.minOut)}`);
  console.log(`- path     : ${plan.path?.join(" -> ") || "-"}`);

  if (plan.warnings?.length) {
    console.log("\nExecutor: ⚠️ WARNINGS:");
    for (const w of plan.warnings) console.log(`- ${w}`);
  } else {
    console.log("\nExecutor: no warnings ✅");
  }

  const mustConfirm = (plan.warnings?.length || 0) > 0;

  console.log("\nExecutor: confirm gate");
  if (!confirmFn) {
    if (mustConfirm) {
      console.log("Executor: AUTO-ABORT (warnings present)");
      return { ok: false };
    }
    console.log("Executor: AUTO-APPROVE (no warnings)");
  } else {
    const q = mustConfirm
      ? "Warnings detected. Proceed anyway? (y/n)"
      : "Proceed with swap? (y/n)";

    const ans = await confirmFn(q);
    if (!yn(ans)) {
      console.log("Executor: rejected ❌");
      return { ok: false };
    }
    console.log("Executor: confirmed ✅");
  }

  console.log("\nExecutor: executing swap…");
  await sleep(300);

  const res = await executeFn(plan);

  console.log("Executor: execution result ✅");
  console.log(`- status: ${res.status}`);
  console.log(`- txid  : ${res.txid}`);

  return { ok: true, ...res };
}

// ===== MOCK BACKEND =====
async function quoteFn(input) {
  return {
    amountOut: Number(input.amountIn) * 0.95,
    minOut: Number(input.amountIn) * 0.92,
    path: [input.tokenIn, "USDC", input.tokenOut],
    warnings: input.tokenOut === "SCAM" ? ["Token risky"] : [],
  };
}

async function executeFn(plan) {
  return {
    status: "success",
    txid: "0x" + Math.random().toString(16).slice(2),
  };
}

function confirmFn(q) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((res) => {
    rl.question(q + " ", (ans) => {
      rl.close();
      res(ans);
    });
  });
}

// ===== MAIN FLOW =====
async function runSwap() {
  const input = {
    chain: "solana",
    tokenIn: "SOL",
    tokenOut: "USDC",
    amountIn: 1,
    slippageBps: 100,
  };

  console.log("\n🚀 START MULTI-AGENT SWAP");

  const plan = await agentScout({ quoteFn, input });
  const result = await agentExecutor({ executeFn, plan, confirmFn });

  console.log("\n=== FINAL RESULT ===");
  console.log(result);
}

// ===== MENU =====
function menu() {
  console.log(`
==== MENU ====
1. Run Swap (Multi-Agent)
2. Exit
`);
}

function ask() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Choose: ", async (ans) => {
    rl.close();

    if (ans === "1") {
      await runSwap();
      ask();
    } else {
      console.log("Bye 👋");
      process.exit(0);
    }
  });
}

// ===== START =====
menu();
ask();
