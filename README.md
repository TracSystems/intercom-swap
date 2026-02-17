# Intercom Swap

This repo is a fork of upstream **Intercom** (Trac-Systems/intercom): a reference implementation of the Intercom stack on Trac Network for an internet of agents.

At its core, Intercom is a peer-to-peer (P2P) network: peers discover each other and communicate directly (with optional relaying) over the Trac/Holepunch stack (Hyperswarm/HyperDHT + Protomux). There is no central server required for sidechannel messaging.

This fork adds a non-custodial swap harness:

- Negotiate via **request-for-quote (RFQ)** messages over **Intercom sidechannels** (P2P).
- Settle **BTC over Lightning** <> **USDT on Solana** using a shared Solana escrow program (HTLC-style).

Links:
- Upstream Intercom: `https://github.com/Trac-Systems/intercom`
- This fork: `https://github.com/TracSystems/intercom-swap`

## Architecture (High-Level)
Intercom Swap is a local-first P2P system with one core runtime and multiple optional control/settlement paths.

```text
                 Humans + Autonomous Agents
                            |
             +--------------+--------------+
             |                             |
       Structured control             Natural language
      (UI + tool calls)              (optional prompting)
             |                             |
             +--------------+--------------+
                            v
                   Intercom runtime peer
                (identity + local state store)
                            |
          +-----------------+-------------------+
          |                                     |
          v                                     v
  P2P coordination fabric                 Optional app extension
  - Sidechannels (RFQ + swap)            - Local-first contracts/features
  - Subnet replication                    - Trac Network tx path (TNK gas)
                            |
             +--------------+--------------+
             |                             |
             v                             v
     Lightning settlement             Solana settlement
          (BTC leg)                     (USDT leg)
```

Key idea:
- Intercom handles coordination and agent communication.
- Settlement happens on Lightning + Solana.
- Contract usage on Trac Network is optional and extensible.

---

## What Intercom Is

Intercom is a Trac stack for autonomous agents:
- **Sidechannels**: fast, ephemeral P2P messaging (Hyperswarm + Noise).
- **Features**: integrate non-agent services/tools into the same network.
- **Contracts (optional)**: deterministic state + optional chat.
- **MSB (optional)**: value-settled transactions.

This fork keeps Intercom intact and layers swap + ops tooling on top.

---

## Table Of Contents

- [Run Strategy Matrix](#run-strategy-matrix)
- [Install And Operate From `SKILL.md`](#install-and-operate-from-skillmd)
- [How To Use `SKILL.md` With An Agent](#how-to-use-skillmd-with-an-agent)
- [Conceptual Flow (BTC(LN) <> USDT(Solana))](#conceptual-flow-btcln--usdtsolana)
- [External APIs / RPCs (Defaults)](#external-apis--rpcs-defaults)
- [Command Surface (Scripts = "Function Calls")](#command-surface-scripts--function-calls)
- [Start Intercom Peers (`run-swap-*`)](#start-intercom-peers-run-swap-)
- [SC-Bridge Control (`swapctl`)](#sc-bridge-control-swapctl)
- [RFQ Bots (`rfq-maker` / `rfq-taker`)](#rfq-bots-rfq-maker--rfq-taker)
- [Recovery (`swaprecover`)](#recovery-swaprecover)
- [Solana Wallet Tooling (`solctl`)](#solana-wallet-tooling-solctl)
- [Solana Escrow Program Tooling (`escrowctl`)](#solana-escrow-program-tooling-escrowctl)
- [Lightning Operator Tooling (`lnctl`)](#lightning-operator-tooling-lnctl)
- [Optional LND Local Lifecycle (`lndctl` / `lndpw`)](#optional-lnd-local-lifecycle-lndctl--lndpw)
- [Prompt Router (Optional)](#prompt-router-optional)
- [Tests (Mandatory)](#tests-mandatory)
- [Secrets + Repo Hygiene](#secrets--repo-hygiene)

---

## Run Strategy Matrix

Choose one path before running commands. Do not mix paths in a single instance.

| Goal | Path | Typical Network | Data Isolation Rule |
|---|---|---|---|
| Validate code and workflows | Test path | LN regtest + Solana local/devnet | test stores + test receipts DB + test promptd port |
| Upgrade an existing deployment | Upgrade path | same as current deployment | keep backup, preserve current stores, rerun tests |
| Operate with real funds | Mainnet path | LN mainnet + Solana mainnet | separate mainnet stores/receipts/ports; never reuse test data |
| Human-first operation | Collin path | any | Collin talks to one promptd instance at a time |
| Agent-first automation | Headless path | any | prefer deterministic scripts/tool calls over free-form prompting |

Minimal rule set:
- Always decide `test` vs `mainnet` first.
- Keep test and mainnet fully separated (store names, DB paths, ports, audit dirs).
- For mainnet, use public DHT bootstraps (local DHT is test-only).
- Run tests before first live settlement.

---

## Install And Operate From `SKILL.md`

`SKILL.md` is the canonical **installer + runbook** for this repo. If you are an agent, treat it as the source of truth for:
- installation steps
- runtime requirements (Pear, Node)
- first-run decisions (sidechannels, invites, PoW)
- operations (LN/Solana, recovery, tests)

### Recommended Models (For Install/Upgrades)

Installation and large merges are easiest with a top-tier coding model.

Recommended:
- OpenAI: **GPT-5.3+** (Codex, `xhigh`)
- Anthropic: **Claude Opus 4.6+**

OpenClaw can use and control this stack autonomously (install/upgrade via `SKILL.md`, ops via scripts and optional `promptd` tool calls, including backend worker tools `intercomswap_tradeauto_*`).

Local/open-weight models can work too, but use a high-grade one.

---

## How To Use `SKILL.md` With An Agent

Example prompts (copy/paste):

1. Install
```text
Install this repo using SKILL.md. Run all tests (unit + e2e). Report what you ran and any failures.
```

2. Install + staging tests
```text
Install this repo using SKILL.md. Run unit + local e2e. Then run a smoke test on test networks (LN regtest + Solana devnet) if supported. Report results.
```

2b. Decide and execute one run path first
```text
Read SKILL.md and pick exactly one run path (test / upgrade / mainnet / collin / headless). Explain why that path matches the goal, then execute it end-to-end.
```

3. Update workflow
```text
Pull the latest version of this fork, resolve merge conflicts, and run all tests (unit + e2e). If testnet smoke tests exist, run them too. Only then proceed to mainnet checks.
```

3b. Switch to mainnet (fresh instance)
```text
Create a clean mainnet instance: do NOT reuse any test stores or receipts DBs. Wipe/rotate test data only, keep mainnet keys separate. Then bring up mainnet peer + promptd + Collin and run a mainnet readiness checklist (funding + LN channel ready + Solana RPC reachable).
```

4. Mainnet start
```text
Install this repo using SKILL.md, run all tests (unit + e2e), then run the mainnet bring-up checklist and start maker+taker peers on mainnet (with user-provided Solana RPC + Solana keypairs + LN node configuration). Report the exact commands run and any failures.
```

5. Enable Collin prompting (LLM mode)
```text
Enable LLM prompting for Collin. Tell me exactly what config you need (OpenAI-compatible base_url, api_key or token file, model, max_tokens, temperature) and where it must be stored (gitignored). Validate by running a prompt that posts an Offer and confirm it appears in the UI.
```

6. Operator support mode
```text
I’m operating Collin and I’m stuck: “<paste error>”. Explain what it means and the exact next click/command to fix it. Do not guess; inspect the repo and logs.
```

---

## Conceptual Flow (BTC(LN) <> USDT(Solana))

```text
Rendezvous sidechannel(s) (any; examples: 0000intercom, 0000intercomswapbtcusdt, my-swap-room)
    |
    | swap.svc_announce (service + offers[])  [periodic rebroadcast; sidechannels have no history]
    | Offer (optional) -> RFQ (manual or backend-auto-from-offer) -> QUOTE -> QUOTE_ACCEPT
    |   - pre-filter by app_hash + fee caps + refund window
    v
per-trade invite-only swap:<trade_id>
    |
    | TERMS (binding: fees, mint, refund_after_unix, ...)
    | ACCEPT
    | LN_INVOICE (payment_hash)
    | SOL_ESCROW_CREATED (escrow PDA + vault ATA)
    v
Settlement (BTC over Lightning <> USDT on Solana)
  1) Maker creates + posts LN invoice (receiver inbound liquidity check must pass)
  2) Taker runs LN route precheck and posts `ln_route_precheck_ok` (swap.status)
  3) Maker escrows USDT (Solana) only after taker precheck is OK
  4) Taker verifies escrow on-chain (hard rule: no escrow, no pay)
  5) Taker pays LN invoice -> learns preimage
  6) Taker claims USDT on Solana using preimage
  7) Refund path after sol_refund_after_unix if LN payment never happens
```

## External APIs / RPCs (Defaults)

This stack touches a few external endpoints. Defaults are chosen so local e2e is easy, and live ops are configurable:

- Price oracle (HTTP): by default uses public exchange APIs (no keys): `binance,coinbase,gate,kucoin,okx,bitstamp,kraken`.
  - Enabled on peers via `--price-oracle 1` (included in `scripts/run-swap-*.sh`).
  - Configure providers via `--price-providers "<csv>"`.
- Solana (JSON-RPC over HTTP): bots/tools default to local validator `http://127.0.0.1:8899`.
  - Configure via `--solana-rpc-url "<url[,url2,...]>"` (comma-separated failover pool).
- Bitcoin/LN: the BTC leg is **Lightning** (CLN or LND).
  - Local e2e uses docker regtest stacks under `dev/` (includes `bitcoind`).
  - Mainnet uses your local LN node (CLN via `bitcoind` RPC, or LND via `neutrino` or `bitcoind` backend).
  - This repo does not require a separate public Bitcoin explorer API by default.

If any of your HTTP/RPC endpoints require auth headers (Bearer/API tokens), see **Authenticated API Endpoints** near the end of this README.

---

## Command Surface (Scripts = "Function Calls")

After installation, day-to-day operation should be done by invoking scripts (macOS/Linux `.sh`, Windows `.ps1`). The `.mjs` files are the canonical CLIs; wrappers exist to keep invocation stable and tool-call friendly.

### Script Index

| Area | macOS/Linux | Windows | Canonical | Purpose |
|---|---|---|---|---|
| Bootstrap | `scripts/bootstrap.sh` | n/a | bash | Install Pear runtime + deps |
| Start peer (maker/service) | `scripts/run-swap-maker.sh` | `scripts/run-swap-maker.ps1` | shell | Start a peer with SC-Bridge + price oracle and join an RFQ channel |
| Start peer (taker/client) | `scripts/run-swap-taker.sh` | `scripts/run-swap-taker.ps1` | shell | Start a peer with SC-Bridge + price oracle and join an RFQ channel; pins `SWAP_INVITER_KEYS` for `swap:*` |
| Peer lifecycle supervisor | `scripts/peermgr.sh` | `scripts/peermgr.ps1` | `scripts/peermgr.mjs` | Start/stop/restart background peers (headless) without keeping a terminal open |
| SC-Bridge control | `scripts/swapctl.sh` | `scripts/swapctl.ps1` | `scripts/swapctl.mjs` | Sidechannel ops + signed message helpers |
| SC-Bridge control (token auto) | `scripts/swapctl-peer.sh` | `scripts/swapctl-peer.ps1` | wrapper | Same as `swapctl`, but reads token from `onchain/sc-bridge/<store>.token` |
| RFQ maker bot | `scripts/rfq-maker-peer.sh` | `scripts/rfq-maker-peer.ps1` | `scripts/rfq-maker.mjs` | Quote RFQs; optionally run full swap state machine |
| RFQ taker bot | `scripts/rfq-taker-peer.sh` | `scripts/rfq-taker-peer.ps1` | `scripts/rfq-taker.mjs` | Send RFQ; accept quote; optionally run full swap state machine |
| RFQ bot control | `scripts/rfqbotmgr.sh` | `scripts/rfqbotmgr.ps1` | `scripts/rfqbotmgr.mjs` | Start/stop/restart RFQ bot instances without stopping the peer |
| Recovery | `scripts/swaprecover.sh` | `scripts/swaprecover.ps1` | `scripts/swaprecover.mjs` | List/show receipts; claim/refund escrows |
| Solana wallet ops | `scripts/solctl.sh` | `scripts/solctl.ps1` | `scripts/solctl.mjs` | Keypairs, balances, ATA, token transfers |
| Solana escrow ops | `scripts/escrowctl.sh` | `scripts/escrowctl.ps1` | `scripts/escrowctl.mjs` | Program config, fee vaults, escrow inspection |
| Solana program ops (maintainers) | `scripts/solprogctl.sh` | `scripts/solprogctl.ps1` | `scripts/solprogctl.mjs` | Build/deploy the Solana program |
| Lightning ops | `scripts/lnctl.sh` | `scripts/lnctl.ps1` | `scripts/lnctl.mjs` | Addresses, channels, invoices, payments |
| LND local lifecycle (optional) | `scripts/lndctl.sh` | `scripts/lndctl.ps1` | `scripts/lndctl.mjs` | Generate `lnd.conf`, start/stop, create/unlock wallet |
| LND password helper (optional) | `scripts/lndpw.sh` | `scripts/lndpw.ps1` | shell | Write an LND wallet password file (no trailing newline) |

---

### Start Intercom Peers (`run-swap-*`)

| Function call | What it does | Parameters |
|---|---|---|
| `scripts/run-swap-maker.sh [storeName] [scBridgePort] [rfqChannel] [...extra peer flags]` | Starts a maker/service peer, enables SC-Bridge + price oracle, joins the RFQ channel | Positional args; optional env: `SIDECHANNEL_POW` (default `1`), `SIDECHANNEL_POW_DIFFICULTY` (default `12`) |
| `SWAP_INVITER_KEYS="<makerPeerPubkeyHex[,more]>" scripts/run-swap-taker.sh [storeName] [scBridgePort] [rfqChannel] [...extra peer flags]` | Starts a taker/client peer and pins inviter key(s) for `swap:*` invite-only channels | Requires `SWAP_INVITER_KEYS`; same optional env vars as maker |

Notes:
| Item | Details |
|---|---|
| Token files | Created under `onchain/sc-bridge/<storeName>.token` (gitignored). |
| RFQ channel | Any sidechannel works. Many operators use a dedicated rendezvous (example: `0000intercomswapbtcusdt`) to reduce noise, but `0000intercom` works too. |
| Subnet channel | Keep `--subnet-channel` consistent across peers (mismatches can prevent connections). |

---

### Peer Lifecycle Supervisor (`peermgr`)

`peermgr` is a local supervisor for starting/stopping `pear run` peers in the background (so you don’t need to keep a terminal open).

Notes:
- It enforces: **never run the same peer store twice**.
- It stores state + logs under `onchain/peers/` (gitignored).
- It always starts the peer in **headless mode** (`--terminal 0`).

#### Commands

| Command | What it does |
|---|---|
| `scripts/peermgr.sh start --name <id> --store <peerStoreName> --sc-port <n> --sidechannels <csv>` | Start a peer and join one or more extra sidechannels on startup |
| `scripts/peermgr.sh stop --name <id>` | Stop the peer process |
| `scripts/peermgr.sh restart --name <id>` | Restart using the last saved config |
| `scripts/peermgr.sh status [--name <id>]` | Show state + PID + liveness |

---

### SC-Bridge Control (`swapctl`)

`swapctl` is the SC-Bridge client CLI. It controls a **running peer** over WebSocket, and (when needed) signs locally using the peer keypair file (SC-Bridge never signs).

#### Connection

| Flag | Required | Meaning |
|---|---:|---|
| `--url ws://127.0.0.1:<scPort>` | yes | SC-Bridge websocket URL |
| `--token <hex>` | yes | SC-Bridge token (from `onchain/sc-bridge/<store>.token`) |
| `--peer-keypair <path>` | signing only | Peer `keypair.json` (usually `stores/<store>/db/keypair.json`) for commands that create signed payloads |

#### Token Convenience Wrapper (Recommended)

| Wrapper | What it does |
|---|---|
| `scripts/swapctl-peer.sh <storeName> <scPort> <swapctl command...>` | Reads `onchain/sc-bridge/<storeName>.token` and calls `swapctl` with `--url/--token` |
| `scripts/swapctl-peer.ps1 <storeName> <scPort> <swapctl command...>` | Same for Windows |

#### Command Reference

##### Introspection

| Command | What it does | Important flags |
|---|---|---|
| `info` | Peer info (pubkey, joined channels, SC-Bridge status) | none |
| `stats` | Peer runtime stats | none |
| `price-get` | Price snapshot from the peer's price feature | none |
| `watch` | Stream messages for debugging/observability | `--channels <a,b,c>`, `--kinds <k1,k2>`, `--trade-id <id>`, `--pretty 0/1`, `--raw 0/1` |

##### Sidechannel I/O

| Command | What it does | Flags |
|---|---|---|
| `join` | Join a sidechannel | `--channel <name>`; optional: `--invite <b64/json/@file>`, `--welcome <b64/json/@file>` |
| `leave` | Leave a sidechannel | `--channel <name>` |
| `open` | Request others to open a channel (via the entry channel) | `--channel <name> --via <entryChannel>`; optional: `--invite <...>`, `--welcome <...>` |
| `send` | Send plaintext or JSON to a channel | `--channel <name>` and one of: `--text <msg>` or `--json <obj/@file>`; optional: `--invite <...>`, `--welcome <...>` |

##### Service Presence (Directory Beacon)

| Command | What it does | Flags |
|---|---|---|
| `svc-announce` | Broadcast a signed service announcement | Required: `--channels <a,b,c> --name <label>`; optional: `--pairs <p1,p2>`, `--rfq-channels <a,b,c>`, `--note <text>`, `--offers-json <json/@file>`, `--trade-id <id>`, `--ttl-sec <sec>`, `--join 0/1` |
| `svc-announce-loop` | Periodically re-broadcast announcements (sidechannels have no history) | Required: `--channels <a,b,c> --config <json/@file>`; optional: `--interval-sec <sec>`, `--watch 0/1`, `--ttl-sec <sec>`, `--trade-id <id>`, `--join 0/1` |

##### Welcome/Invite Helpers (Owner-Signed)

| Command | What it does | Flags |
|---|---|---|
| `make-welcome` | Create a signed welcome payload | `--channel <name> --text <welcomeText>` |
| `make-invite` | Create a signed invite payload | `--channel <name> --invitee-pubkey <hex32>`; optional: `--ttl-sec <sec>`, `--welcome <b64/json/@file>` |

##### Swap Message Helpers (Signed Envelopes)

| Command | What it does | Flags |
|---|---|---|
| `rfq` | Send RFQ to an RFQ channel | `--channel <rfqChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr>`; optional: `--valid-until-unix <sec>` |
| `quote` | Send quote | `--channel <rfqChannel> --trade-id <id> --rfq-id <id> --btc-sats <n> --usdt-amount <atomicStr> --valid-until-unix <sec>` |
| `quote-from-rfq` | Build + send a quote from an RFQ envelope | `--channel <rfqChannel> --rfq-json <envelope/@file>`; optional: `--btc-sats <n>`, `--usdt-amount <atomicStr>`, `--valid-until-unix <sec>` |
| `quote-accept` | Accept a quote | `--channel <rfqChannel> --quote-json <envelope/@file>` |
| `swap-invite-from-accept` | Create and send a `swap:<trade_id>` invite after acceptance | `--channel <rfqChannel> --accept-json <envelope/@file>`; optional: `--swap-channel <name>`, `--welcome-text <text>`, `--ttl-sec <sec>` |
| `join-from-swap-invite` | Join a swap channel using a swap-invite envelope | `--swap-invite-json <envelope/@file>` |
| `terms` | Send swap terms into `swap:<id>` | Required: `--channel <swapChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> --sol-mint <base58> --sol-recipient <base58> --sol-refund <base58> --sol-refund-after-unix <sec> --ln-receiver-peer <hex32> --ln-payer-peer <hex32> --platform-fee-bps <n> --trade-fee-bps <n> --trade-fee-collector <base58>`; optional: `--platform-fee-collector <base58>`, `--terms-valid-until-unix <sec>` |
| `accept` | Accept swap terms | `--channel <swapChannel> --trade-id <id>` and one of: `--terms-hash <hex>` or `--terms-json <envelope/body/@file>` |

##### Verification

| Command | What it does | Flags |
|---|---|---|
| `verify-prepay` | Validate that terms, invoice, and escrow match; optionally validate escrow on-chain | Required: `--terms-json <envelope/body/@file> --invoice-json <envelope/body/@file> --escrow-json <envelope/body/@file>`; optional: `--now-unix <sec>`, `--solana-rpc-url <url[,url2,...]>`, `--solana-commitment <confirmed/finalized/processed>` |

---

### RFQ Bots (`rfq-maker` / `rfq-taker`)

These are long-running bots that sit in an RFQ channel and negotiate RFQ/quotes. With `--run-swap 1` they run the full swap state machine inside an invite-only `swap:<trade_id>` channel.

#### Wrappers

| Wrapper | What it does |
|---|---|
| `scripts/rfq-maker-peer.sh <storeName> <scPort> [...flags]` | Runs the maker bot against a running peer (reads token from `onchain/sc-bridge/<storeName>.token`) |
| `scripts/rfq-maker-peer.ps1 <storeName> <scPort> [...flags]` | Same for Windows |
| `scripts/rfq-taker-peer.sh <storeName> <scPort> [...flags]` | Runs the taker bot against a running peer (reads token from `onchain/sc-bridge/<storeName>.token`) |
| `scripts/rfq-taker-peer.ps1 <storeName> <scPort> [...flags]` | Same for Windows |

#### Bot Lifecycle (No Peer Downtime)

Prefer `rfqbotmgr` for tool-call operation: stop/restart individual bot instances without touching `pear run`.

| Function call | What it does |
|---|---|
| `scripts/rfqbotmgr.sh start-maker --name <id> --store <peerStore> --sc-port <n> -- [...rfq-maker flags]` | Start a maker bot in the background (logs under `onchain/rfq-bots/`) |
| `scripts/rfqbotmgr.sh start-taker --name <id> --store <peerStore> --sc-port <n> -- [...rfq-taker flags]` | Start a taker bot in the background |
| `scripts/rfqbotmgr.sh stop --name <id>` | Stop a running bot |
| `scripts/rfqbotmgr.sh restart --name <id>` | Restart a bot with the last saved args |
| `scripts/rfqbotmgr.sh status [--name <id>]` | Show bot state + PID + liveness |

#### `rfq-maker` Flags (`scripts/rfq-maker.mjs`)

##### General

| Flag | Meaning |
|---|---|
| `--rfq-channel <name>` | RFQ negotiation channel (default `0000intercomswapbtcusdt`) |
| `--swap-channel-template <tmpl>` | Swap channel name template (default `swap:{trade_id}`) |
| `--quote-valid-sec <n>` | Quote validity window (default `60`) |
| `--invite-ttl-sec <n>` | Invite TTL (default `604800`) |
| `--once 0/1` | Exit after one completed swap (default `0`) |
| `--once-exit-delay-ms <n>` | Delay before exiting when `--once 1` (default `750`) |
| `--debug 0/1` | Verbose logs (default `0`) |
| `--receipts-db <path>` | Receipts DB path (recommended: `onchain/receipts/rfq-bots/<store>/<bot>.sqlite`) |

##### Pricing Policy

- Price is negotiated strictly from RFQ/Offer terms (`btc_sats`, `usdt_amount`).
- Oracle snapshots are informational only (UI/ops visibility), not settlement gates.
- Open RFQs (`usdt_amount=0`) are not supported in bot flow; amounts must be explicit.

##### Swap Execution (`--run-swap 1`)

| Flag | Meaning |
|---|---|
| `--run-swap 0/1` | Execute the full swap state machine (default `0`) |
| `--swap-timeout-sec <n>` | Per-swap timeout (default `300`) |
| `--swap-resend-ms <n>` | Proof resend interval (default `1200`) |
| `--terms-valid-sec <n>` | Terms validity window (default `300`) |
| `--solana-refund-after-sec <n>` | Solana refund timelock from terms send time (default `259200` = 72h) |
| `--ln-invoice-expiry-sec <n>` | LN invoice expiry seconds (default `3600`) |

##### Solana

| Flag | Meaning |
|---|---|
| `--solana-rpc-url <url[,url2,...]>` | Solana RPC pool (default `http://127.0.0.1:8899`) |
| `--solana-keypair <path>` | Maker Solana keypair (required when `--run-swap 1`) |
| `--solana-mint <pubkey>` | SPL mint for escrow (required when `--run-swap 1`) |
| `--solana-decimals <n>` | Mint decimals (default `6` for mainnet USDT) |
| `--solana-program-id <pubkey>` | Override program id (defaults to the compiled-in shared program id) |
| `--solana-cu-limit <units>` | Optional compute unit limit |
| `--solana-cu-price <microLamports>` | Optional priority fee |
| `--solana-trade-fee-collector <pubkey>` | Which trade-fee config PDA to use (defaults to platform fee collector) |

##### Lightning

| Flag | Meaning |
|---|---|
| `--ln-impl <cln/lnd>` | Lightning implementation (default `cln`) |
| `--ln-backend <docker/cli>` | Lightning backend (default `docker`) |
| `--ln-compose-file <path>` | Docker compose file (default `dev/ln-regtest/docker-compose.yml`) |
| `--ln-service <name>` | Docker service name (required when `--ln-backend docker`) |
| `--ln-network <regtest/signet/mainnet/...>` | Lightning network (default `regtest`) |
| `--ln-cli-bin <path>` | CLI binary override (for `--ln-backend cli`) |

##### LND CLI Backend Extras (Only if `--ln-impl lnd --ln-backend cli`)

| Flag | Meaning |
|---|---|
| `--lnd-rpcserver <host:port>` | LND RPC server (for `lncli`) |
| `--lnd-tlscert <path>` | TLS cert path |
| `--lnd-macaroon <path>` | Macaroon path |
| `--lnd-dir <path>` | LND dir |

#### `rfq-taker` Flags (`scripts/rfq-taker.mjs`)

##### General

| Flag | Meaning |
|---|---|
| `--trade-id <id>` | Trade id (default random) |
| `--rfq-channel <name>` | RFQ negotiation channel (default `0000intercomswapbtcusdt`) |
| `--btc-sats <n>` | Sats requested (default `50000`) |
| `--usdt-amount <atomicStr>` | USDT requested (base units, must be > 0) |
| `--rfq-valid-sec <n>` | RFQ validity window (default `60`) |
| `--timeout-sec <n>` | RFQ/quote negotiation timeout (default `30`) |
| `--rfq-resend-ms <n>` | RFQ resend interval (default `1200`) |
| `--accept-resend-ms <n>` | Quote accept resend interval (default `1200`) |
| `--once 0/1` | Exit after one completed swap (default `0`) |
| `--once-exit-delay-ms <n>` | Delay before exiting when `--once 1` (default `200`) |
| `--debug 0/1` | Verbose logs (default `0`) |
| `--receipts-db <path>` | Receipts DB path (recommended: `onchain/receipts/rfq-bots/<store>/<bot>.sqlite`) |
| `--persist-preimage 0/1` | Persist `ln_preimage_hex` into receipts (default `1` when receipts enabled) |
| `--stop-after-ln-pay 0/1` | Testing/recovery hook: stop after paying LN (default `0`) |

##### Pricing Policy

- Taker accepts/rejects quotes by negotiated terms + protocol guardrails (fees/windows/signers/app binding), not oracle thresholds.
- Oracle remains informational only.

##### Swap Execution (`--run-swap 1`)

| Flag | Meaning |
|---|---|
| `--run-swap 0/1` | Execute the full swap state machine (default `0`) |
| `--swap-timeout-sec <n>` | Per-swap timeout (default `300`) |
| `--swap-resend-ms <n>` | Proof resend interval (default `1200`) |
| `--min-solana-refund-window-sec <n>` | Reject TERMS where `sol_refund_after_unix - now` is below this (default `3600` = 1h) |
| `--max-solana-refund-window-sec <n>` | Reject TERMS where `sol_refund_after_unix - now` is above this (default `604800` = 1w) |
| `--max-platform-fee-bps <n>` | Reject TERMS with platform fee above this (default `500`) |
| `--max-trade-fee-bps <n>` | Reject TERMS with trade fee above this (default `1000`) |
| `--max-total-fee-bps <n>` | Reject TERMS with total fee above this (default `1500`) |

##### Solana

| Flag | Meaning |
|---|---|
| `--solana-rpc-url <url[,url2,...]>` | Solana RPC pool (default `http://127.0.0.1:8899`) |
| `--solana-keypair <path>` | Taker Solana keypair (required when `--run-swap 1`) |
| `--solana-mint <pubkey>` | SPL mint for escrow (required when `--run-swap 1`) |
| `--solana-decimals <n>` | Mint decimals (default `6`) |
| `--solana-program-id <pubkey>` | Override program id (defaults to the compiled-in shared program id) |
| `--solana-cu-limit <units>` | Optional compute unit limit |
| `--solana-cu-price <microLamports>` | Optional priority fee |

##### Lightning

| Flag | Meaning |
|---|---|
| `--ln-impl <cln/lnd>` | Lightning implementation (default `cln`) |
| `--ln-backend <docker/cli>` | Lightning backend (default `docker`) |
| `--ln-compose-file <path>` | Docker compose file (default `dev/ln-regtest/docker-compose.yml`) |
| `--ln-service <name>` | Docker service name (required when `--ln-backend docker`) |
| `--ln-network <regtest/signet/mainnet/...>` | Lightning network (default `regtest`) |
| `--ln-cli-bin <path>` | CLI binary override (for `--ln-backend cli`) |

##### LND CLI Backend Extras (Only if `--ln-impl lnd --ln-backend cli`)

| Flag | Meaning |
|---|---|
| `--lnd-rpcserver <host:port>` | LND RPC server (for `lncli`) |
| `--lnd-tlscert <path>` | TLS cert path |
| `--lnd-macaroon <path>` | Macaroon path |
| `--lnd-dir <path>` | LND dir |

---

### Recovery (`swaprecover`)

`swaprecover` provides a deterministic recovery path using the local receipts DB.

#### Global Flags

| Flag | Meaning |
|---|---|
| `--receipts-db <path>` | Receipts DB (SQLite; should live under `onchain/`) |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `list` | List trades in receipts | Optional: `--limit <n>` |
| `show` | Show one trade | One of: `--trade-id <id>`, `--payment-hash <hex32>` |
| `claim` | Claim Solana escrow if LN was paid but agent crashed | One of: `--trade-id <id>`, `--payment-hash <hex32>`; required: `--solana-rpc-url <csv>`, `--solana-keypair <path>` |
| `refund` | Refund Solana escrow after timeout | One of: `--trade-id <id>`, `--payment-hash <hex32>`; required: `--solana-rpc-url <csv>`, `--solana-keypair <path>` |

---

### Solana Wallet Tooling (`solctl`)

#### Global Flags

| Flag | Meaning |
|---|---|
| `--rpc-url <url[,url2,...]>` | RPC pool (default `http://127.0.0.1:8899`) |
| `--commitment <processed/confirmed/finalized>` | Commitment (default `confirmed`) |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `keygen` | Create a keypair | `--out <path>`; optional: `--seed-hex <hex32>`, `--force 0/1` |
| `address` | Print pubkey | `--keypair <path>` |
| `balance` | SOL balance | `--keypair <path>` |
| `airdrop` | Devnet/testnet airdrop | `--keypair <path> --sol <n>` |
| `transfer-sol` | Send SOL | `--keypair <path> --to <pubkey> --sol <n>` |
| `mint-create` | Create a test mint | `--keypair <path> --decimals <n>`; optional: `--out <path>` |
| `mint-info` | Inspect mint | `--mint <pubkey>` |
| `token-ata` | Print or create ATA | `--keypair <path> --mint <pubkey>`; optional: `--owner <pubkey>`, `--create 0/1` |
| `token-balance` | SPL token balance | `--keypair <path> --mint <pubkey>`; optional: `--owner <pubkey>` |
| `token-transfer` | Transfer SPL tokens | `--keypair <path> --mint <pubkey> --to <pubkey> --amount <u64>`; optional: `--create-ata 0/1` |
| `mint-to` | Mint test tokens | `--keypair <path> --mint <pubkey> --to <pubkey> --amount <u64>`; optional: `--create-ata 0/1` |
| `inventory` | Print balances across mints | `--keypair <path>`; optional: `--mints <csvPubkeys>` |

---

### Solana Escrow Program Tooling (`escrowctl`)

#### Global Flags

| Flag | Meaning |
|---|---|
| `--solana-rpc-url <url[,url2,...]>` | RPC pool (default `http://127.0.0.1:8899`) |
| `--commitment <processed/confirmed/finalized>` | Commitment (default `confirmed`) |
| `--program-id <base58>` | Override program id (default is the shared program id compiled into the client) |
| `--solana-cu-limit <units>` | Optional compute unit limit |
| `--solana-cu-price <microLamports>` | Optional priority fee |
| `--solana-keypair <path>` | Required for signing commands (`config-init`, `config-set`, withdrawals, trade config init/set) |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `config-get` | Read platform config | none |
| `config-init` | Initialize platform fee config (fixed `10` bps / 0.1%) | optional: `--fee-collector <pubkey>`, `--simulate 0/1`, `--fee-bps 10` |
| `config-set` | Update platform fee collector (fee stays fixed at `10` bps / 0.1%) | optional: `--fee-collector <pubkey>`, `--simulate 0/1`, `--fee-bps 10` |
| `fees-balance` | Platform fee vault balance | `--mint <pubkey>` |
| `fees-withdraw` | Withdraw platform fees | `--mint <pubkey>`; optional: `--amount <u64>`, `--create-ata 0/1`, `--simulate 0/1` |
| `trade-config-get` | Read trade fee config | `--fee-collector <pubkey>` |
| `trade-config-init` | Initialize trade fee config (default `10` bps / 0.1% when omitted) | optional: `--fee-bps <n>`, `--fee-collector <pubkey>`, `--simulate 0/1` |
| `trade-config-set` | Update trade fee config (default `10` bps / 0.1% when omitted) | optional: `--fee-bps <n>`, `--fee-collector <pubkey>`, `--simulate 0/1` |
| `trade-fees-balance` | Trade fee vault balance | `--fee-collector <pubkey> --mint <pubkey>` |
| `trade-fees-withdraw` | Withdraw trade fees (for the signer fee collector) | `--mint <pubkey>`; optional: `--amount <u64>`, `--create-ata 0/1`, `--simulate 0/1` |
| `escrow-get` | Inspect escrow state | `--payment-hash <hex32>` |

---

### Solana Program Build/Deploy (`solprogctl`) (Maintainers Only)

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `id` | Print the program id used by the codebase | none |
| `build` | Build the SBF program | none (requires Rust + Solana CLI toolchain) |
| `deploy` | Deploy/upgrade the program | Required: `--rpc-url <url> --payer <keypair.json> --program-keypair <keypair.json>`; optional: `--upgrade-authority <keypair.json>`, `--so <path>`, `--dry-run 0/1` |
| `keypair-pubkey` | Print a program pubkey from a keypair file | `--program-keypair <keypair.json>` |

---

### Lightning Operator Tooling (`lnctl`)

#### Global Flags

| Flag | Meaning |
|---|---|
| `--impl <cln/lnd>` | Implementation (default `cln`) |
| `--backend <cli/docker>` | Backend (default `cli`) |
| `--network <bitcoin/mainnet/testnet/regtest/signet>` | Network (default `regtest`) |
| `--compose-file <path>` | Docker backend compose (default `dev/ln-regtest/docker-compose.yml`) |
| `--service <name>` | Docker service name (required for docker backend) |
| `--cli-bin <path>` | CLI binary override |
| `--lnd-rpcserver <host:port>` | LND CLI backend extra |
| `--lnd-tlscert <path>` | LND CLI backend extra |
| `--lnd-macaroon <path>` | LND CLI backend extra |
| `--lnd-dir <path>` | LND CLI backend extra |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `info` | Node info | none |
| `newaddr` | New on-chain address | none |
| `listpeers` | List connected peers (and advertised addresses) | none |
| `listfunds` | Wallet + channel balances | none |
| `balance` | Alias of listfunds wallet balance | none |
| `connect` | Connect to a peer | `--peer <nodeid@host:port>` |
| `fundchannel` | Open a channel | `--node-id <hex> --amount-sats <n>` |
| `closechannel` | Close a channel (returns liquidity to on-chain wallet) | `--channel-id <id>`; optional: `--force 0/1`, `--sat-per-vbyte <n>` |
| `invoice` | Create invoice | `--msat <amountmsat> --label <label> --desc <text>`; optional: `--expiry <sec>` |
| `decodepay` | Decode a BOLT11 invoice | `--bolt11 <invoice>` |
| `pay` | Pay invoice | `--bolt11 <invoice>` |
| `pay-status` | Payment status | `--payment-hash <hex32>` |
| `preimage-get` | Preimage lookup (for recovery) | `--payment-hash <hex32>` |

---

### Optional LND Local Lifecycle (`lndctl` / `lndpw`)

This is only for running LND from a local directory under `onchain/` (not required if you use the docker deployments in `dev/`).

#### `lndctl` Commands

| Command | What it does | Synopsis |
|---|---|---|
| `init` | Generate `lnd.conf` under `onchain/` | `init --node <name> [--network <mainnet/testnet/signet/regtest>] [--lnd-dir <path>] [--alias <str>] [--p2p-port <n>] [--rpc-port <n>] [--rest-port <n>] [--bitcoin-node <neutrino/bitcoind>] [--neutrino-peers <host:port[,..]>] [--wallet-password-file <path>]` |
| `start` | Start `lnd` | `start --node <name> [--network <...>] [--lnd-dir <path>] [--lnd-bin <path>]` |
| `stop` | Stop `lnd` | `stop --node <name> [--network <...>] [--lnd-dir <path>] [--lncli-bin <path>]` |
| `create-wallet` | Create wallet (interactive) | `create-wallet --node <name> [--network <...>] [--lnd-dir <path>] [--lncli-bin <path>]` |
| `unlock` | Unlock wallet (interactive) | `unlock --node <name> [--network <...>] [--lnd-dir <path>] [--lncli-bin <path>]` |
| `paths` | Print TLS/macaroon paths | `paths --node <name> [--network <...>] [--lnd-dir <path>]` |

#### `lndpw` Helper

| Function call | What it does | Parameters |
|---|---|---|
| `scripts/lndpw.sh <outFile>` | Writes a password file (no trailing newline) | Positional: `<outFile>` (example: `onchain/lnd/mainnet/maker/wallet.pw`) |

---

## Prompt Router (Optional)

This repo includes an optional **prompt router + tool executor** (`promptd`) that:
- calls an OpenAI-compatible LLM endpoint
- executes *only* the safe tool surface (SC-Bridge safe RPC + deterministic scripts)
- writes an audit trail under `onchain/`
- keeps swap secrets out of the model context (preimages, invites/welcomes) by using opaque `secret:<id>` handles

### Tool Discovery + Coverage

Canonical sources (always up to date):
- Tool schemas + parameters: `src/prompt/tools.js`
- Validation + runtime behavior: `src/prompt/executor.js`
- LLM system/tool policy: `src/prompt/system.js`

Tool index (complete):

Complete prompt-tool index (source of truth: `src/prompt/tools.js`, runtime behavior: `src/prompt/executor.js`).

#### Core
| Tool | Description |
|---|---|
| `intercomswap_app_info` | Get app binding info (app_tag, Solana program id, derived app_hash). |
| `intercomswap_env_get` | Get local environment/config summary (LN network, Solana RPC, receipts DB path). Does not touch the network. |
| `intercomswap_stack_start` | Start/bootstrap the local stack (peer + SC-Bridge, LN regtest channel on docker, Solana local validator, receipts DB). |
| `intercomswap_stack_stop` | Stop the local stack (peer + Solana local validator + LN docker). Does not delete state. |

#### SC-Bridge
| Tool | Description |
|---|---|
| `intercomswap_sc_info` | Get peer info via SC-Bridge (safe fields only). |
| `intercomswap_sc_stats` | Get SC-Bridge stats. |
| `intercomswap_sc_price_get` | Get latest price snapshot from local price feature/oracle. |
| `intercomswap_sc_subscribe` | Subscribe this prompt session to sidechannel message events for specific channels. |
| `intercomswap_sc_wait_envelope` | Wait for the next signed swap envelope seen on subscribed sidechannels. Returns a handle to the full envelope. |
| `intercomswap_sc_join` | Join a sidechannel (invite/welcome optional). |
| `intercomswap_sc_join_many` | Join multiple sidechannels (public rendezvous style). |
| `intercomswap_sc_leave` | Leave a sidechannel locally (channel hygiene). |
| `intercomswap_sc_leave_many` | Leave multiple sidechannels locally (channel hygiene). |
| `intercomswap_sc_open` | Request/open a sidechannel via an entry channel (invite/welcome optional). |
| `intercomswap_sc_send_text` | Send a plain text message to a channel. |
| `intercomswap_sc_send_json` | Send a JSON message to a channel (structured payload). |

#### Peer Lifecycle
| Tool | Description |
|---|---|
| `intercomswap_peer_status` | List local peer instances started via prompt tools (reads onchain/peers). |
| `intercomswap_peer_start` | Start a local peer instance (detached pear run process). |
| `intercomswap_peer_stop` | Stop a local peer instance (by instance name). |
| `intercomswap_peer_restart` | Restart a local peer instance (stop then start using last config). |

#### RFQ/Offer/Quote
| Tool | Description |
|---|---|
| `intercomswap_offer_post` | Post a signed Offer announcement (swap.svc_announce) into rendezvous channels (advertise: have USDT, want BTC; prompts BTC sellers to post matching RFQs). |
| `intercomswap_rfq_post` | Post a signed RFQ envelope into an RFQ rendezvous channel (BTC_LN->USDT_SOL: sell BTC for USDT). |
| `intercomswap_quote_post` | Post a signed QUOTE envelope into an RFQ channel (references an RFQ id). Fees are read from on-chain config/trade-config (not negotiated). Provide either valid_until_unix or valid_for_sec. |
| `intercomswap_quote_post_from_rfq` | Maker: post a signed QUOTE that matches an RFQ envelope (no manual rfq_id/btc_sats/usdt_amount required). Fees are read from on-chain config/trade-config (not negotiated). Provide either valid_until_unix or valid_for_sec. |
| `intercomswap_quote_accept` | Post a signed QUOTE_ACCEPT envelope into the RFQ channel (accept a quote). |
| `intercomswap_swap_invite_from_accept` | Maker: generate welcome+invite and post SWAP_INVITE into the RFQ channel, based on an accepted quote. |
| `intercomswap_join_from_swap_invite` | Taker: join swap:<id> channel using SWAP_INVITE envelope. |

#### Trade Automation
| Tool | Description |
|---|---|
| `intercomswap_tradeauto_status` | Get backend trade-automation worker status and memory counters. |
| `intercomswap_tradeauto_trace_set` | Enable/disable backend trade-automation trace emission (off by default). |
| `intercomswap_tradeauto_start` | Start backend multi-trade automation worker for subscribed sidechannels. |
| `intercomswap_tradeauto_stop` | Stop backend multi-trade automation worker. |

#### RFQ Bots
| Tool | Description |
|---|---|
| `intercomswap_rfqbot_status` | List local RFQ bot instances started via prompt tools (reads onchain/rfq-bots). |
| `intercomswap_rfqbot_start_maker` | Start a maker RFQ bot instance (detached background process). |
| `intercomswap_rfqbot_start_taker` | Start a taker RFQ bot instance (detached background process). |
| `intercomswap_rfqbot_stop` | Stop an RFQ bot instance (by instance name). |
| `intercomswap_rfqbot_restart` | Restart an RFQ bot instance (stop then start using last config). |

#### Autopost
| Tool | Description |
|---|---|
| `intercomswap_autopost_status` | List in-process autopost jobs started via tools (offer/rfq repost schedulers). |
| `intercomswap_autopost_start` | Start a periodic repost scheduler for offer_post or rfq_post. |
| `intercomswap_autopost_stop` | Stop an autopost job (by name). |

#### Swap Messaging
| Tool | Description |
|---|---|
| `intercomswap_terms_post` | Maker: post signed TERMS envelope inside swap:<id>. |
| `intercomswap_terms_accept` | Taker: post signed ACCEPT inside swap:<id> referencing the terms hash. |
| `intercomswap_swap_status_post` | Post signed STATUS envelope inside swap:<id> (informational; used for liveness handshakes). |
| `intercomswap_swap_cancel_post` | Post signed CANCEL envelope inside swap:<id> (only allowed before escrow is created). |
| `intercomswap_terms_accept_from_terms` | Taker: post signed ACCEPT inside swap:<id> from a TERMS envelope (computes terms hash). |

#### Lightning Docker/Lifecycle
| Tool | Description |
|---|---|
| `intercomswap_ln_docker_ps` | Docker-only: show docker compose service status for the configured LN compose stack. |
| `intercomswap_ln_docker_up` | Docker-only: start LN docker services (defaults to bitcoind + configured LN service). |
| `intercomswap_ln_docker_down` | Docker-only: stop the LN docker compose stack. |
| `intercomswap_ln_regtest_init` | Docker-only (regtest): bootstrap a funded Lightning channel between the two nodes in the compose stack (mine, fund, connect, open channel). |
| `intercomswap_ln_unlock` | LND-only: unlock the wallet (docker backend). Uses ln.wallet_password_file from prompt setup, or an inferred file under onchain/lnd/<network>/ (gitignored). |

#### Lightning Operations
| Tool | Description |
|---|---|
| `intercomswap_ln_info` | Get Lightning node info (impl/backend configured locally). |
| `intercomswap_ln_newaddr` | Get a new on-chain BTC address from the LN node wallet. |
| `intercomswap_ln_listpeers` | List connected Lightning peers (used to suggest peer URIs). |
| `intercomswap_ln_listfunds` | Get on-chain + channel balances. |
| `intercomswap_ln_listchannels` | List Lightning channels with peer/state/balance details (for channel management). |
| `intercomswap_ln_closechannel` | Close a Lightning channel (cooperative by default) to return liquidity to on-chain BTC. |
| `intercomswap_ln_withdraw` | Send on-chain BTC from the LN node wallet to a BTC address. |
| `intercomswap_ln_connect` | Connect to a Lightning peer (nodeid@host:port). |
| `intercomswap_ln_peer_probe` | Probe a Lightning peer (TCP reachability + LN connect state). Optionally attempts reconnect. |
| `intercomswap_ln_fundchannel` | Open a public Lightning channel to a peer. |
| `intercomswap_ln_splice` | Splice a Lightning channel in/out (CLN experimental splicing only). Use positive sats to add liquidity and negative sats to remove liquidity. |
| `intercomswap_ln_invoice_create` | Create a standard BOLT11 invoice (no hodl invoices). |
| `intercomswap_ln_decodepay` | Decode a BOLT11 invoice offline. |
| `intercomswap_ln_pay` | Pay a BOLT11 invoice. |
| `intercomswap_ln_rebalance_selfpay` | Best-effort inbound rebalance: create an invoice on this node and pay it from this same node. Works best with LND using allow_self_payment; routing outcome depends on available channels/routes. |
| `intercomswap_ln_pay_status` | Query payment status by payment_hash. |
| `intercomswap_ln_preimage_get` | Get a payment preimage by payment_hash (for recovery). |

#### Swap Settlement Helpers
| Tool | Description |
|---|---|
| `intercomswap_swap_ln_invoice_create_and_post` | Maker: create an LN invoice and post LN_INVOICE into swap:<id>. |
| `intercomswap_swap_sol_escrow_init_and_post` | Maker: init Solana escrow and post SOL_ESCROW_CREATED into swap:<id>. Requires taker to post ln_route_precheck_ok (swap.status) after LN invoice is posted. Fees are read from on-chain config/trade-config (not negotiated). |
| `intercomswap_swap_verify_pre_pay` | Taker: verify (terms + LN invoice + Sol escrow) and validate the escrow exists on-chain before paying. Also enforces safety margins: rejects if the invoice expires too soon (<60s) or the escrow refund_after is too soon (<10min). |
| `intercomswap_swap_ln_route_precheck_from_terms_invoice` | Taker: decode invoice and run LN route/liquidity precheck from signed TERMS + LN_INVOICE before maker escrow is created. |
| `intercomswap_swap_ln_pay_and_post` | Taker: pay the LN invoice and post LN_PAID into swap:<id>. |
| `intercomswap_swap_ln_pay_and_post_from_invoice` | Taker: pay an LN invoice from an LN_INVOICE envelope and post LN_PAID into swap:<id> (no manual bolt11/payment_hash copying). |
| `intercomswap_swap_ln_pay_and_post_verified` | Taker: verify (terms + invoice + escrow on-chain), then pay the LN invoice and post LN_PAID into swap:<id>. Enforces the same safety margins as verify_pre_pay (invoice expiry + refund_after). |
| `intercomswap_swap_sol_claim_and_post` | Taker: claim Solana escrow and post SOL_CLAIMED into swap:<id>. |

#### Solana Operations
| Tool | Description |
|---|---|
| `intercomswap_sol_local_status` | Local-only: show whether a solana-test-validator RPC is listening on the configured localhost port (and whether it was started by this repo). |
| `intercomswap_sol_local_start` | Local-only: start solana-test-validator with the escrow program loaded (writes ledger/logs under onchain/). |
| `intercomswap_sol_local_stop` | Local-only: stop the managed solana-test-validator process. |
| `intercomswap_sol_signer_pubkey` | Get the configured Solana signer pubkey for this promptd instance. |
| `intercomswap_sol_keygen` | Generate a new Solana keypair JSON file under onchain/ (gitignored). |
| `intercomswap_sol_keypair_pubkey` | Get the pubkey for a Solana keypair JSON file (path must be under onchain/). |
| `intercomswap_sol_airdrop` | Request an airdrop (local validator/test only; mainnet will fail). |
| `intercomswap_sol_transfer_sol` | Transfer SOL from the configured signer to a recipient pubkey. |
| `intercomswap_sol_token_transfer` | Transfer an SPL token (ATA->ATA) from the signer to a recipient owner pubkey. |
| `intercomswap_sol_mint_create` | Create a new SPL mint where the signer is mint+freeze authority (test/dev convenience). |
| `intercomswap_sol_mint_to` | Mint SPL tokens from a signer-controlled mint to a recipient owner pubkey (test/dev convenience). |
| `intercomswap_sol_balance` | Get SOL balance for a pubkey. |
| `intercomswap_sol_token_balance` | Get SPL token balance for a (owner,mint) pair (ATA). |
| `intercomswap_sol_escrow_get` | Fetch escrow state by payment_hash (and mint). |
| `intercomswap_sol_escrow_init` | Initialize an escrow locked to LN payment_hash. Fees are read from on-chain config/trade-config (not negotiated). |
| `intercomswap_sol_escrow_claim` | Claim escrow by submitting LN preimage (recipient signature required). |
| `intercomswap_sol_escrow_refund` | Refund escrow after timeout (refund signature required). |
| `intercomswap_sol_config_get` | Get program fee config (platform config PDA). |
| `intercomswap_sol_config_set` | Set program fee config (admin authority required; platform fee is fixed at 10 bps). |
| `intercomswap_sol_fees_withdraw` | Withdraw accrued platform fees from fee vault (admin authority required). |
| `intercomswap_sol_trade_config_get` | Get trade fee config (per fee_collector). |
| `intercomswap_sol_trade_config_set` | Init/set trade fee config (fee_collector authority required; defaults to 10 bps when omitted). |
| `intercomswap_sol_trade_fees_withdraw` | Withdraw accrued trade fees for the configured fee_collector. |

#### Receipts/Recovery
| Tool | Description |
|---|---|
| `intercomswap_receipts_list` | List local trade receipts (sqlite). |
| `intercomswap_receipts_show` | Show a local receipt by trade_id. |
| `intercomswap_receipts_list_open_claims` | List trades that look claimable (state=ln_paid and preimage present). |
| `intercomswap_receipts_list_open_refunds` | List trades that look refundable (state=escrow and refund_after <= now). Uses local receipt data only. |
| `intercomswap_swaprecover_claim` | Recover: claim a stuck Solana escrow using local receipts + signer. |
| `intercomswap_swaprecover_refund` | Recover: refund an expired Solana escrow using local receipts + signer. |

Total tools documented: 102.

When function signatures change:
- Update this README command/tool references.
- Update `SKILL.md` guidance.
- Keep `src/prompt/tools.js` and `src/prompt/executor.js` in sync (schema vs execution).

### Setup (JSON, Gitignored)

All prompt configuration lives in a local JSON file (recommended path: `onchain/prompt/setup.json`), which is gitignored by default.  
No environment variables are required for `promptd` configuration.

Generate a template:
```bash
./scripts/promptd.sh --print-template > onchain/prompt/setup.json
```

Edit `onchain/prompt/setup.json`:
- `llm.base_url`: your OpenAI-compatible REST API base (typically ends with `/v1`)
- `llm.model`: model id to use
- `llm.api_key`: optional (use `""` if not required)
- `llm.call_style`: `openai` or `functiongemma`
  - if omitted, promptd auto-detects `functiongemma` when `llm.model` contains `functiongemma`; otherwise `openai`
- `llm.prompt_profile`:
  - `default` (full IntercomSwap system/tool policy)
  - `functiongemma_minimal` (lean prompt intended for FunctionGemma-style tool callers)
- `llm.tool_schema_profile`:
  - `full` (entire tool schemas)
  - `compact` (default for `openai`; reduced schema verbosity)
  - `minimal` (default for `functiongemma`; required fields only)
  - `names_only` (tool names + empty parameter schema; smallest payload)
- legacy: `llm.tools_compact` (default `true`): maps to `tool_schema_profile=compact` (or `full` when set to `false`) if `llm.tool_schema_profile` is not set.
  - `llm.tools_compact_keep_tool_descriptions` (default `true`)
  - `llm.tools_compact_keep_schema_descriptions` (default `false`)
- `llm.tools_select_pass` (default `false`): optional two-pass prompting (select tool names first, then run tool-calling with only those tools).
  - `llm.tools_select_max_tools` (default `16`)
- FunctionGemma tip: do not force OpenAI `response_format` JSON mode unless you specifically need it.
- FunctionGemma runtime profile (recommended explicit config):
  - `llm.call_style: "functiongemma"`
  - `llm.prompt_profile: "functiongemma_minimal"`
  - `llm.tool_schema_profile: "minimal"`
  - omit `llm.response_format` unless required by your backend
- `peer.keypair`: path to the peer wallet keypair file (usually `stores/<store>/db/keypair.json`) so tools can sign sidechannel envelopes locally
- optional sampling params: `max_tokens`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`
- `sc_bridge.token` or `sc_bridge.token_file`
- `receipts.db` (optional, for `intercomswap_receipts_*` tools)
- `ln.*`, `solana.*` (optional, depending on which tools you want enabled)
- trade automation bootstrap (optional, defaults shown):
  - `server.tradeauto_autostart` (default `true`): backend trade worker starts automatically on promptd startup.
  - `server.tradeauto_channels` (default `["0000intercomswapbtcusdt","0000intercom"]`).
  - `server.tradeauto_trace_enabled` (default `false`): trace is off by default.
  - `server.tradeauto_autostart_retry_ms` (default `5000`), `server.tradeauto_autostart_max_attempts` (default `24`).

Start the service:
```bash
./scripts/promptd.sh --config onchain/prompt/setup.json
```

Optional server hardening (recommended if you expose `promptd` beyond localhost, e.g. via ngrok):
- `server.auth_token`: requires `Authorization: Bearer <token>` on all `/v1/*` endpoints
- `server.tls`: serve HTTPS instead of HTTP (provide `key` + `cert` paths under `onchain/`)

Run prompts:
```bash
./scripts/promptctl.sh --prompt "Show SC-Bridge info"
./scripts/promptctl.sh --auto-approve 1 --prompt "Post an RFQ in 0000intercomswapbtcusdt"
```

If `server.auth_token` is set, add `--auth-token`:
```bash
./scripts/promptctl.sh --auth-token "<token>" --prompt "Show SC-Bridge info"
```

### Secret Handles (No Leaks To The Model)

Some tool outputs are sensitive (LN preimages, swap invites/welcomes). `promptd` will replace these values with `secret:<id>` handles before sending tool results back to the model. Later tool calls can pass those handles back, and the executor will resolve them server-side.

### Streaming Endpoints (For UI)

`promptd` also exposes NDJSON streaming endpoints for memory-safe UIs:
- `POST /v1/run/stream` (stream prompt execution events)
- `GET /v1/sc/stream` (stream sidechannel events received via SC-Bridge)

### Collin UI (Local Control Center)

This repo includes **Collin**, a local-first control center UI (prompting is only one part of it).

- Source: `ui/collin/`
- Served by: `promptd` (same origin as `/v1/*`, no CORS issues)
- UI feeds are **virtualized** and use **backscroll paging** to keep the DOM/memory stable.

Important: Collin’s live sidechannel stream (`/v1/sc/stream`) requires a **running peer with SC-Bridge enabled**.
Start a peer first (or start it from Collin via the `peer_*` tools once `promptd` is running).

Collin also enforces a hard **STACK READY** gate for trade tools (RFQ/Offer/Bots/Swap protocol):
- peer + SC-Bridge running
- `sc/stream` connected
- Lightning has **at least one channel**
- Solana signer + program config reachable
- receipts DB configured (for recovery)

For docker regtest, Collin includes a one-click Lightning bootstrap (`intercomswap_ln_regtest_init`) that mines, funds both LN nodes, and opens a channel.

Current Collin wallet/trading guardrails:
- Sell USDT / Sell BTC line editors show live wallet snapshots (LN liquidity, USDT atomic balance, SOL lamports).
- Posting is blocked when balances/liquidity are insufficient:
  - LN route buffer included for BTC send checks.
  - USDT requirement includes fee-cap headroom.
  - SOL tx-fee buffer required for claim/refund/transfer paths.
- Channel Manager defaults to **ACINQ** on mainnet (reduces isolated topology `NO_ROUTE` incidents).
  - Manual peer URI selection is available under an **Advanced** expander.
  - Quick peer URI suggestions come from `intercomswap_ln_listpeers`.
- Autopost bots stop automatically on insufficient-funds/liquidity errors (and stop on expiry/fill as before).
- Trade automation now runs server-side (backend worker via `intercomswap_tradeauto_*`), not in browser state. Collin no longer owns client-side settlement loops.
- Collin sidechannel stream processing deduplicates repeated SC events (including reconnect backlog duplicates) before inserting into the local event store to keep browser CPU/load bounded.
  - dedupe uses signed envelope identity first (not seq-first), so re-sent identical envelopes with fresh seq values are dropped.
  - UI stream rendering is batched (instead of per-event re-render) and dedupe-map pruning runs periodically (instead of per-event full scans) to prevent browser lockups during high-volume replay windows.
- Collin keeps invite-only `swap:*` trade channels separate from rendezvous settings:
  - trade channels can be auto-watched for stream visibility after join/invite,
  - but they are never promoted into the global rendezvous channel configuration used for stack start or Offer/RFQ broadcast.
- If backend trace shows `stopped`, start/stop it directly in Collin Overview (`Trade Automation Trace`) or call `intercomswap_tradeauto_start` / `intercomswap_tradeauto_stop`.

Examples:
```bash
# Background peer (recommended; doesn’t require keeping a terminal open)
scripts/peermgr.sh start --name swap-maker-peer --store swap-maker --sc-port 49222 --sidechannels 0000intercomswapbtcusdt

# Foreground peer (dev convenience)
scripts/run-swap-maker.sh swap-maker 49222 0000intercomswapbtcusdt
```

Build the UI:
```bash
cd ui/collin
npm install
npm run build
```

Run the UI (via `promptd`):
```bash
./scripts/promptd.sh --config onchain/prompt/setup.json
```

Open:
- `http://127.0.0.1:9333/`

Dev mode (HMR) with a built-in proxy for `/v1` and `/healthz`:
```bash
cd ui/collin
npm run dev
```

---

## Test vs Mainnet (Run As Separate Instances)
Do **not** “toggle” one running instance between test and mainnet. Run **two separate instances** so you never mix:
- peer stores / keys
- promptd ports (also isolates Collin’s browser DB by origin)
- SC‑Bridge ports + tokens
- receipts sqlite DBs (`receipts.db`)
- prompt audit logs (`server.audit_dir`)

Recommended conventions:
- Test rendezvous channel: `0000intercomswapbtcusdt_test`
- Mainnet rendezvous channel: `0000intercomswapbtcusdt`

Example promptd configs (all under `onchain/` so they are gitignored):
- Test: `onchain/prompt/test/setup.json`
  - `server.port`: `9333`
  - `receipts.db`: `onchain/receipts/test/swap-maker.sqlite`
  - `server.audit_dir`: `onchain/prompt/audit-test`
  - `ln.network`: `regtest` (or `signet`)
  - `solana.rpc_url`: local validator / devnet
- Mainnet: `onchain/prompt/mainnet/setup.json`
  - `server.port`: `9334`
  - `receipts.db`: `onchain/receipts/mainnet/swap-maker.sqlite`
  - `server.audit_dir`: `onchain/prompt/audit-mainnet`
  - `ln.network`: `bitcoin`
  - `solana.rpc_url`: mainnet RPC(s)

Collin shows an **ENV** indicator (TEST/MAINNET/MIXED) from `intercomswap_env_get` and displays the active `receipts.db` path so you can sanity-check before moving funds.

---

## Tests (Mandatory)

Run all tests after changes:
```bash
npm test
npm run test:e2e
```

---

## Secrets + Repo Hygiene

- `onchain/` contains local wallets, node data, tokens, and other secrets/runtime state and must never be committed.
- `progress.md` is a local handoff log and is gitignored.

### Authenticated API Endpoints (Bearer/API Tokens)

Some price/RPC/API providers require auth headers (for example `Authorization: Bearer ...`).

This repo supports URL-prefix based header injection via one of:
- `HTTP_HEADERS_JSON` (JSON string)
- `HTTP_HEADERS_FILE` (path to JSON file)
- `onchain/http/headers.json` (default, if present; gitignored)

Example `onchain/http/headers.json`:
```json
{
  "rules": [
    {
      "match": "https://rpc.example.com/",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  ]
}
```

Matching rules:
- `match` is a simple string prefix (or `*` for all URLs).
- If multiple rules match, longer prefixes override shorter ones.

## TRAC Address
trac1mujqz79ft4drmn4w7xdxux25lrsdqwvd3pxu3rgsl5rnpzcsq7mq9fegmc
