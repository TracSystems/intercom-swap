import { banner, sleep, fmt } from "./agentShared.js";

function yn(input) {
  const s = String(input || "").trim().toLowerCase();
  return s === "y" || s === "yes";
}

export async function agentExecutor({ executeFn, plan, confirmFn }) {
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
    console.log("\nExecutor: ⚠️ WARNINGS from Scout:");
    for (const w of plan.warnings) console.log(`- ${w}`);
  } else {
    console.log("\nExecutor: no warnings ✅");
  }

  // Confirm gate: kalau ada warnings, Executor jadi “tegas”
  const mustConfirm = (plan.warnings?.length || 0) > 0;

  console.log("\nExecutor: confirm gate");
  if (!confirmFn) {
    // fallback default: auto-deny if warnings, auto-approve if clean
    if (mustConfirm) {
      console.log("Executor: confirmFn missing → AUTO-ABORT (warnings present).");
      return { ok: false, reason: "missing_confirmFn_with_warnings" };
    }
    console.log("Executor: confirmFn missing → AUTO-APPROVE (no warnings).");
  } else {
    const question = mustConfirm
      ? "Warnings detected. Proceed anyway? (y/n)"
      : "Proceed with swap execution? (y/n)";

    const answer = await confirmFn(question);
    if (!yn(answer)) {
      console.log("Executor: user rejected ❌ aborting.");
      return { ok: false, reason: "user_rejected" };
    }
    console.log("Executor: user confirmed ✅");
  }

  console.log("\nExecutor: executing swap…");
  await sleep(250);

  // executeFn expect returns { txid, status, details? }
  const res = await executeFn(plan);
  await sleep(200);

  console.log("Executor: execution result ✅");
  console.log(`- status: ${res.status || "unknown"}`);
  console.log(`- txid  : ${res.txid || "-"}`);

  if (res.details) {
    console.log("- details:");
    console.log(res.details);
  }

  return { ok: true, ...res };
}
