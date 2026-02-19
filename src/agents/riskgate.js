import { step, info } from "../core/logger.js";
import { validateAmount, validateSlippage } from "../core/validation.js";

function now() {
  return Date.now();
}

function fmtAge(ms) {
  if (ms == null) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * RiskGate:
 * - Basic checks: amount/slippage, chain supported
 * - Dexscreener heuristic risk scoring:
 *   - liquidity too low
 *   - token too new
 *   - 24h volume too low
 *   - sells=0 (potential honeypot indicator; not definitive)
 *   - insane price change (pump/dump)
 *
 * Output:
 * - attaches `risk` object: score, level, flags
 * - can BLOCK if too risky (configurable)
 */
export function agentRiskGate(input) {
  step("RISK");

  validateAmount(input.amount);
  validateSlippage(input.slippageBps);

  const chain = (input.chain || "").toLowerCase();
  if (!["sol", "base"].includes(chain)) {
    throw new Error(`Unsupported chain: ${input.chain} (supported: sol, base)`);
  }

  // ---- configurable thresholds (env optional) ----
  const MIN_LIQ_USD = Number(process.env.RISK_MIN_LIQ_USD || "15000");     // $15k
  const MIN_VOL24_USD = Number(process.env.RISK_MIN_VOL24_USD || "5000");  // $5k
  const MIN_AGE_MIN = Number(process.env.RISK_MIN_AGE_MIN || "60");        // 60 minutes
  const MAX_PUMP_PCT = Number(process.env.RISK_MAX_PUMP_PCT || "250");     // 250% 24h change
  const BLOCK_SCORE = Number(process.env.RISK_BLOCK_SCORE || "75");        // >=75 block

  const flags = [];
  let score = 0;

  // ---- market snapshot from analyst (optional) ----
  const snap = input.market?.bestPair || null;

  if (!snap) {
    flags.push("NO_MARKET_SNAPSHOT");
    score += 10; // mild
  } else {
    // liquidity
    if (snap.liquidityUsd < MIN_LIQ_USD) {
      flags.push(`LOW_LIQUIDITY_$${Math.round(snap.liquidityUsd)}`);
      score += 35;
    }

    // age
    const ageMin = snap.ageMs != null ? Math.floor(snap.ageMs / 60000) : null;
    if (ageMin != null && ageMin < MIN_AGE_MIN) {
      flags.push(`TOO_NEW_${fmtAge(snap.ageMs)}`);
      score += 25;
    }

    // volume
    if (snap.volume24hUsd < MIN_VOL24_USD) {
      flags.push(`LOW_VOLUME24H_$${Math.round(snap.volume24hUsd)}`);
      score += 20;
    }

    // suspicious sells
    if (snap.buys24h > 0 && snap.sells24h === 0) {
      flags.push("NO_SELLS_24H (possible honeypot/illiquid)");
      score += 30;
    }

    // huge pump/dump
    if (snap.priceChange24hPct != null && Math.abs(snap.priceChange24hPct) > MAX_PUMP_PCT) {
      flags.push(`EXTREME_PRICE_CHANGE_24H_${snap.priceChange24hPct}%`);
      score += 25;
    }
  }

  // slippage safety
  if (Number(input.slippageBps) > 200) {
    flags.push("HIGH_SLIPPAGE_BPS");
    score += 15;
  }

  // Normalize score
  if (score > 100) score = 100;

  const level = score >= BLOCK_SCORE ? "BLOCK" : (score >= 45 ? "CAUTION" : "SAFE");

  const risk = {
    score,
    level,
    flags,
    thresholds: {
      MIN_LIQ_USD,
      MIN_VOL24_USD,
      MIN_AGE_MIN,
      MAX_PUMP_PCT,
      BLOCK_SCORE
    },
    marketSummary: snap
      ? {
          dex: snap.dex,
          pair: snap.pairAddress,
          liquidityUsd: snap.liquidityUsd,
          volume24hUsd: snap.volume24hUsd,
          buys24h: snap.buys24h,
          sells24h: snap.sells24h,
          age: fmtAge(snap.ageMs),
          priceChange24hPct: snap.priceChange24hPct
        }
      : null
  };

  info(`RiskGate: level=${risk.level} score=${risk.score}`);
  if (risk.flags.length) info(`Flags: ${risk.flags.join(" | ")}`);

  // Default: block risky token BEFORE execute
  if (risk.level === "BLOCK" && !process.env.RISK_ALLOW_BLOCKED) {
    throw new Error(`RiskGate BLOCKED swap: score=${risk.score} flags=${risk.flags.join(", ")}`);
  }

  return { ...input, chain, risk };
}
