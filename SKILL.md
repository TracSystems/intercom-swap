# 🧠 SKILL — INTERCOM SWAP BY PAK EKO

SIGNAL: <BUY | HOLD | SELL>  
RISK: <SAFE | CAUTION | BLOCK>  
DECISION: <EXECUTE SWAP | WAIT | REJECT>

---

## WHY:

- Multi-agent pipeline ensures structured decision making (Scout → Analyst → RiskGate → Executor)
- Dexscreener data provides real-time liquidity, volume, and market behavior insight
- Risk engine prevents execution on unsafe tokens (low liquidity, no sells, extreme volatility)
- Direct integration with Jupiter enables real MAINNET execution
- CLI-first design reduces attack surface (no frontend exposure)

---

## FLAGS:

- LOW_LIQUIDITY  
- LOW_VOLUME  
- NO_SELLS_24H  
- TOO_NEW_TOKEN  
- EXTREME_PRICE_CHANGE  
- HIGH_SLIPPAGE  
- INVALID_TOKEN_ADDRESS  

---

## CHECKLIST:

- [ ] Token input valid (symbol or mint/CA)
- [ ] Token has liquidity on Dexscreener
- [ ] Volume 24h above minimum threshold
- [ ] Buy/Sell activity looks normal
- [ ] Slippage within safe range
- [ ] Wallet has sufficient balance
- [ ] RPC endpoint responsive
- [ ] Private key loaded securely (env only)

---

## EXECUTION FLOW:

1. User input received (CLI / Agent prompt)
2. Scout parses intent → structured swap plan
3. Analyst fetches Dexscreener market data
4. RiskGate evaluates:
   - liquidity
   - volume
   - token age
   - transaction pattern
5. Decision made:
   - SAFE → proceed
   - CAUTION → optional proceed
   - BLOCK → reject
6. Executor:
   - fetch Jupiter quote
   - build transaction
   - sign using private key
   - broadcast to Solana MAINNET

---

## INPUT FORMAT:

Example:
```
swap 1 usdc to sol slippage 0.5%
```

Supported:
- Symbol → USDC, SOL
- Mint → EPjFWdd5...
- CA → 0x... (future EVM support)

---

## OUTPUT STRUCTURE:

```json
{
  "chain": "sol",
  "tokenIn": "USDC",
  "tokenOut": "SOL",
  "amount": "1",
  "slippageBps": 50,
  "risk": {
    "level": "SAFE",
    "score": 20
  },
  "txid": "xxxxx",
  "status": "success"
}
```

---

## SECURITY NOTES:

- Private key NEVER logged
- Only loaded from `.env`
- Recommend burner wallet only
- No storage of sensitive data
- No external signing exposure

---

## SYSTEM CHARACTER:

- CLI-native (no UI attack surface)
- Deterministic execution pipeline
- AI optional (Groq fallback safe)
- Modular agents (easy to extend)
- Production-ready prototype

---

## FINAL DECISION LOGIC:

IF:
- liquidity OK
- volume OK
- no suspicious pattern

THEN:
→ SIGNAL: BUY  
→ RISK: SAFE  
→ DECISION: EXECUTE SWAP  

ELSE IF:
- medium risk detected

THEN:
→ SIGNAL: HOLD  
→ RISK: CAUTION  
→ DECISION: WAIT  

ELSE:
→ SIGNAL: SELL / AVOID  
→ RISK: BLOCK  
→ DECISION: REJECT  

---

## SUMMARY:

This skill demonstrates a **real-world AI-assisted trading execution system**  
with **on-chain interaction**, **risk awareness**, and **agent-based architecture**.

Not a simulation. Real execution enabled.
