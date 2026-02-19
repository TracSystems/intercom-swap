import readline from "readline";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import dotenv from "dotenv";

import { agentScout } from "../agents/scout.js";
import { agentAnalyst } from "../agents/analyst.js";
import { agentRiskGate } from "../agents/riskgate.js";
import { agentExecutor } from "../agents/executor.js";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (q) => new Promise((res) => rl.question(q, res));

// ================= HEADER =================

function header() {
  console.clear();
  console.log(
    boxen(
      chalk.greenBright(`
INTERCOM SWAP BY PAK EKO 🚀
      `),
      {
        padding: 1,
        borderColor: "green",
        borderStyle: "round"
      }
    )
  );
}

// ================= MENU =================

function menuUI() {
  console.log(
    chalk.cyan(`
1. Quote (Preview)
2. Swap (Execute)
3. Agent (AI)
4. Exit
`)
  );
}

// ================= HELPERS =================

function renderMarket(r) {
  const snap = r?.market?.bestPair;
  if (!snap) {
    return chalk.gray("Market: (no Dexscreener snapshot)\n");
  }

  const age = snap.ageMs != null ? `${Math.floor(snap.ageMs / 60000)}m` : "unknown";
  return (
    chalk.whiteBright("Market snapshot (Dexscreener)\n") +
    `- Chain: ${snap.chainId}\n` +
    `- DEX: ${snap.dex}\n` +
    `- Pair: ${snap.pairAddress}\n` +
    `- PriceUsd: ${snap.priceUsd ?? "n/a"}\n` +
    `- LiquidityUsd: $${Math.round(snap.liquidityUsd || 0)}\n` +
    `- Volume24hUsd: $${Math.round(snap.volume24hUsd || 0)}\n` +
    `- Buys/Sells 24h: ${snap.buys24h || 0}/${snap.sells24h || 0}\n` +
    `- Age: ${age}\n`
  );
}

function renderRisk(r) {
  const risk = r?.risk;
  if (!risk) return chalk.gray("Risk: (no risk object)\n");

  const color =
    risk.level === "SAFE"
      ? chalk.green
      : risk.level === "CAUTION"
      ? chalk.yellow
      : chalk.red;

  const flags = risk.flags?.length ? risk.flags.join(" | ") : "none";

  return (
    chalk.whiteBright("RiskGate\n") +
    `- Level: ${color(risk.level)}\n` +
    `- Score: ${color(String(risk.score))}\n` +
    `- Flags: ${flags}\n`
  );
}

// ================= PIPELINE =================

async function runPipeline(input, opts = {}) {
  const spinner = ora("Running pipeline...").start();

  try {
    // Scout can be async (Groq)
    const s = await agentScout(input);

    // ✅ Analyst is async now (Dexscreener fetch)
    spinner.text = "Analyst: fetching market data...";
    const a = await agentAnalyst(s);

    spinner.text = "RiskGate: evaluating...";
    const r = agentRiskGate(a);

    spinner.stop();

    // Show pre-execution intelligence
    console.log(
      boxen(
        chalk.whiteBright(
          `Plan\n- chain: ${r.chain}\n- in: ${r.tokenIn}\n- out: ${r.tokenOut}\n- amount: ${r.amount}\n- slippageBps: ${r.slippageBps}\n\n` +
            renderMarket(r) +
            "\n" +
            renderRisk(r)
        ),
        { padding: 1, borderColor: r?.risk?.level === "BLOCK" ? "red" : "green" }
      )
    );

    // Re-start spinner for execution
    const execSpin = ora(opts.dryRun ? "Quote mode..." : "Executing swap on-chain...").start();

    const ex = await agentExecutor(r, opts);

    execSpin.succeed(opts.dryRun ? "Quote OK ✅" : "Execute OK ✅");

    const summary = {
      chain: r.chain,
      mode: opts.dryRun ? "dry-run" : "execute",
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: String(r.amount),
      slippageBps: Number(r.slippageBps),
      quote: ex.quote || null,
      txid: ex.txid || null,
      risk: r.risk || null,
      status: "success"
    };

    console.log(
      boxen(chalk.greenBright(JSON.stringify(summary, null, 2)), {
        padding: 1,
        borderColor: "green"
      })
    );

    return ex;
  } catch (e) {
    spinner.fail("Error ❌");
    console.log(chalk.red(e?.message || String(e)));
    return null;
  }
}

// ================= MENU FLOW =================

async function menu() {
  header();
  menuUI();

  const choice = await ask(chalk.yellow("Pilih menu: "));

  // ===== QUOTE =====
  if (choice === "1") {
    const tokenIn = await ask("Token In (symbol/mint/CA): ");
    const tokenOut = await ask("Token Out (symbol/mint/CA): ");
    const amount = await ask("Amount (human, ex: 1 / 0.1): ");
    const sl = await ask("Slippage bps (default 50): ");
    const slippageBps = sl?.trim() ? Number(sl.trim()) : 50;

    console.log(chalk.blue("\n📊 Getting quote...\n"));

    await runPipeline(
      {
        chain: "sol",
        tokenIn,
        tokenOut,
        amount,
        slippageBps
      },
      { dryRun: true }
    );

    return back();
  }

  // ===== SWAP =====
  if (choice === "2") {
    const chain = (await ask("Chain (sol/base) [default sol]: ")).trim() || "sol";
    const tokenIn = await ask("Token In (symbol/mint/CA): ");
    const tokenOut = await ask("Token Out (symbol/mint/CA): ");
    const amount = await ask("Amount (human, ex: 1 / 0.1): ");
    const sl = await ask("Slippage bps (default 50): ");
    const slippageBps = sl?.trim() ? Number(sl.trim()) : 50;

    console.log(chalk.blue("\n📊 Preview first (dry-run)...\n"));

    await runPipeline(
      {
        chain,
        tokenIn,
        tokenOut,
        amount,
        slippageBps
      },
      { dryRun: true }
    );

    const confirm = await ask(chalk.red("Execute swap REAL MAINNET? (y/n): "));

    if (confirm.toLowerCase() === "y") {
      console.log(chalk.green("\n💸 Executing real swap...\n"));

      await runPipeline({
        chain,
        tokenIn,
        tokenOut,
        amount,
        slippageBps
      });
    } else {
      console.log(chalk.gray("Cancelled."));
    }

    return back();
  }

  // ===== AGENT =====
  if (choice === "3") {
    const prompt = await ask("AI Command (boleh pakai CA): ");

    await runPipeline({ prompt });

    return back();
  }

  // ===== EXIT =====
  if (choice === "4") {
    console.log(chalk.green("Bye 🚀"));
    rl.close();
    process.exit(0);
  }

  console.log(chalk.red("Invalid choice"));
  return back();
}

// ================= NAV =================

async function back() {
  await ask(chalk.gray("\nEnter untuk kembali..."));
  return menu();
}

// START
menu();
