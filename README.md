# Intercom Swap

This repo is a fork of upstream **Intercom** (Trac-Systems/intercom): a reference implementation of the Intercom stack on Trac Network for an internet of agents.

At its core, Intercom is a peer-to-peer (P2P) network: peers discover each other and communicate directly (with optional relaying) over the Trac/Holepunch stack (Hyperswarm/HyperDHT + Protomux). There is no central server required for sidechannel messaging.

This fork adds a non-custodial swap harness:

- Negotiate via **request-for-quote (RFQ)** messages over **Intercom sidechannels** (P2P).
- Settle **BTC over Lightning** <> **USDT on Solana** using a shared Solana escrow program (HTLC-style).

Links:
- Upstream Intercom: `https://github.com/Trac-Systems/intercom`
- This fork: `https://github.com/TracSystems/intercom-swap`

## Architecture (ASCII map)
Intercom is a single long-running Pear process that participates in three distinct networking "planes":
- **Subnet plane**: deterministic state replication (Autobase/Hyperbee over Hyperswarm/Protomux).
- **Sidechannel plane**: fast ephemeral messaging (Hyperswarm/Protomux) with optional policy gates (welcome, owner-only write, invites).
- **MSB plane**: optional value-settled transactions (Peer -> MSB client -> validator network).

```text
                          Pear runtime (mandatory)
                pear run . --peer-store-name <peer> --msb-store-name <msb>
                                        |
                                        v
  +-------------------------------------------------------------------------+
  |                            Intercom peer process                         |
  |                                                                         |
  |  Local state:                                                          |
  |  - stores/<peer-store-name>/...   (peer identity, subnet state, etc)    |
  |  - stores/<msb-store-name>/...    (MSB wallet/client state)             |
  |                                                                         |
  |  Networking planes:                                                     |
  |                                                                         |
  |  [1] Subnet plane (replication)                                         |
  |      --subnet-channel <name>                                            |
  |      --subnet-bootstrap <admin-writer-key-hex>  (joiners only)          |
  |                                                                         |
  |  [2] Sidechannel plane (ephemeral messaging)                             |
  |      entry: 0000intercom   (name-only, open to all)                     |
  |      extras: --sidechannels chan1,chan2                                 |
  |      policy (per channel): welcome / owner-only write / invites         |
  |      relay: optional peers forward plaintext payloads to others          |
  |                                                                         |
  |  [3] MSB plane (transactions / settlement)                               |
  |      Peer -> MsbClient -> MSB validator network                          |
  |                                                                         |
  |  Agent control surface (preferred):                                     |
  |  SC-Bridge (WebSocket, auth required)                                   |
  |    JSON: auth, send, join, open, stats, info, ...                       |
  +------------------------------+------------------------------+-----------+
                                 |                              |
                                 | SC-Bridge (ws://host:port)   | P2P (Hyperswarm)
                                 v                              v
                       +-----------------+            +-----------------------+
                       | Agent / tooling |            | Other peers (P2P)     |
                       | (no TTY needed) |<---------->| subnet + sidechannels |
                       +-----------------+            +-----------------------+

  Optional for local testing:
  - --dht-bootstrap "<host:port,host:port>" overrides the peer's HyperDHT bootstraps
    (all peers that should discover each other must use the same list).
```

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

OpenClaw can use and control this stack autonomously (install/upgrade via `SKILL.md`, ops via scripts and optional `promptd` tool calls).

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

3. Update workflow
```text
Pull the latest version of this fork, resolve merge conflicts, and run all tests (unit + e2e). If testnet smoke tests exist, run them too. Only then proceed to mainnet checks.
```

4. Mainnet start
```text
Install this repo using SKILL.md, run all tests (unit + e2e), then run the mainnet bring-up checklist and start maker+taker peers on mainnet (with user-provided Solana RPC + Solana keypairs + LN node configuration). Report the exact commands run and any failures.
```

---

## Conceptual Flow (BTC(LN) <> USDT(Solana))

```text
Rendezvous (directory only)                      Trade negotiation
0000intercom                                     0000intercomswapbtcusdt
    |                                                   |
    | (svc_announce: {name,pairs,rfq_channels})         |  RFQ -> QUOTE -> QUOTE_ACCEPT
    |                                                   v
    +----------------------------------------------> per-trade invite
                                                     swap:<trade_id> (invite-only)
                                                         |
                                                         |  TERMS (includes fees, mint, refund timeout)
                                                         |  ACCEPT
                                                         |  LN_INVOICE (payment_hash)
                                                         |  SOL_ESCROW_CREATED (escrow PDA + vault)
                                                         v
Settlement
  1) Maker creates LN invoice and Solana escrow keyed by payment_hash
  2) Taker verifies escrow on-chain (hard rule: no escrow, no pay)
  3) Taker pays LN invoice -> learns preimage
  4) Taker claims USDT on Solana using preimage
  5) Refund path after timeout if LN payment never happens
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
| RFQ channel | Any channel works. Use a dedicated rendezvous like `0000intercomswapbtcusdt` for trading, and keep `0000intercom` for service presence only. |
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
| `watch` | Stream messages for debugging/observability | `--channels <a,b,c>`, `--kinds <k1,k2>`, `--trade-id <id>`, `--pretty 0|1`, `--raw 0|1` |

##### Sidechannel I/O

| Command | What it does | Flags |
|---|---|---|
| `join` | Join a sidechannel | `--channel <name>`; optional: `--invite <b64|json|@file>`, `--welcome <b64|json|@file>` |
| `leave` | Leave a sidechannel | `--channel <name>` |
| `open` | Request others to open a channel (via the entry channel) | `--channel <name> --via <entryChannel>`; optional: `--invite <...>`, `--welcome <...>` |
| `send` | Send plaintext or JSON to a channel | `--channel <name>` and one of: `--text <msg>` or `--json <obj|@file>`; optional: `--invite <...>`, `--welcome <...>` |

##### Service Presence (Directory Beacon)

| Command | What it does | Flags |
|---|---|---|
| `svc-announce` | Broadcast a signed service announcement | Required: `--channels <a,b,c> --name <label>`; optional: `--pairs <p1,p2>`, `--rfq-channels <a,b,c>`, `--note <text>`, `--offers-json <json|@file>`, `--trade-id <id>`, `--ttl-sec <sec>`, `--join 0|1` |
| `svc-announce-loop` | Periodically re-broadcast announcements (sidechannels have no history) | Required: `--channels <a,b,c> --config <json|@file>`; optional: `--interval-sec <sec>`, `--watch 0|1`, `--ttl-sec <sec>`, `--trade-id <id>`, `--join 0|1` |

##### Welcome/Invite Helpers (Owner-Signed)

| Command | What it does | Flags |
|---|---|---|
| `make-welcome` | Create a signed welcome payload | `--channel <name> --text <welcomeText>` |
| `make-invite` | Create a signed invite payload | `--channel <name> --invitee-pubkey <hex32>`; optional: `--ttl-sec <sec>`, `--welcome <b64|json|@file>` |

##### Swap Message Helpers (Signed Envelopes)

| Command | What it does | Flags |
|---|---|---|
| `rfq` | Send RFQ to an RFQ channel | `--channel <rfqChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr>`; optional: `--valid-until-unix <sec>` |
| `quote` | Send quote | `--channel <rfqChannel> --trade-id <id> --rfq-id <id> --btc-sats <n> --usdt-amount <atomicStr> --valid-until-unix <sec>` |
| `quote-from-rfq` | Build + send a quote from an RFQ envelope | `--channel <rfqChannel> --rfq-json <envelope|@file>`; optional: `--btc-sats <n>`, `--usdt-amount <atomicStr>`, `--valid-until-unix <sec>` |
| `quote-accept` | Accept a quote | `--channel <rfqChannel> --quote-json <envelope|@file>` |
| `swap-invite-from-accept` | Create and send a `swap:<trade_id>` invite after acceptance | `--channel <rfqChannel> --accept-json <envelope|@file>`; optional: `--swap-channel <name>`, `--welcome-text <text>`, `--ttl-sec <sec>` |
| `join-from-swap-invite` | Join a swap channel using a swap-invite envelope | `--swap-invite-json <envelope|@file>` |
| `terms` | Send swap terms into `swap:<id>` | Required: `--channel <swapChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> --sol-mint <base58> --sol-recipient <base58> --sol-refund <base58> --sol-refund-after-unix <sec> --ln-receiver-peer <hex32> --ln-payer-peer <hex32> --platform-fee-bps <n> --trade-fee-bps <n> --trade-fee-collector <base58>`; optional: `--platform-fee-collector <base58>`, `--terms-valid-until-unix <sec>` |
| `accept` | Accept swap terms | `--channel <swapChannel> --trade-id <id>` and one of: `--terms-hash <hex>` or `--terms-json <envelope|body|@file>` |

##### Verification

| Command | What it does | Flags |
|---|---|---|
| `verify-prepay` | Validate that terms, invoice, and escrow match; optionally validate escrow on-chain | Required: `--terms-json <envelope|body|@file> --invoice-json <envelope|body|@file> --escrow-json <envelope|body|@file>`; optional: `--now-unix <sec>`, `--solana-rpc-url <url[,url2,...]>`, `--solana-commitment <confirmed|finalized|processed>` |

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
| `--once 0|1` | Exit after one completed swap (default `0`) |
| `--once-exit-delay-ms <n>` | Delay before exiting when `--once 1` (default `750`) |
| `--debug 0|1` | Verbose logs (default `0`) |
| `--receipts-db <path>` | Receipts DB path (recommended: `onchain/receipts/rfq-bots/<store>/<bot>.sqlite`) |

##### Price Guard (Fail-Closed Quoting)

| Flag | Meaning |
|---|---|
| `--price-guard 0|1` | Enable price guardrails (default `1`) |
| `--price-max-age-ms <n>` | Reject stale snapshots (default `15000`) |
| `--maker-spread-bps <n>` | Quote spread vs oracle (default `0`) |
| `--maker-max-overpay-bps <n>` | If RFQ requests a favorable price for maker, accept it up to this cap (default `0`) |

##### Swap Execution (`--run-swap 1`)

| Flag | Meaning |
|---|---|
| `--run-swap 0|1` | Execute the full swap state machine (default `0`) |
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
| `--ln-impl <cln|lnd>` | Lightning implementation (default `cln`) |
| `--ln-backend <docker|cli>` | Lightning backend (default `docker`) |
| `--ln-compose-file <path>` | Docker compose file (default `dev/ln-regtest/docker-compose.yml`) |
| `--ln-service <name>` | Docker service name (required when `--ln-backend docker`) |
| `--ln-network <regtest|signet|mainnet|...>` | Lightning network (default `regtest`) |
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
| `--usdt-amount <atomicStr>` | USDT requested; `0` means "open RFQ" (maker will quote via oracle) |
| `--rfq-valid-sec <n>` | RFQ validity window (default `60`) |
| `--timeout-sec <n>` | RFQ/quote negotiation timeout (default `30`) |
| `--rfq-resend-ms <n>` | RFQ resend interval (default `1200`) |
| `--accept-resend-ms <n>` | Quote accept resend interval (default `1200`) |
| `--once 0|1` | Exit after one completed swap (default `0`) |
| `--once-exit-delay-ms <n>` | Delay before exiting when `--once 1` (default `200`) |
| `--debug 0|1` | Verbose logs (default `0`) |
| `--receipts-db <path>` | Receipts DB path (recommended: `onchain/receipts/rfq-bots/<store>/<bot>.sqlite`) |
| `--persist-preimage 0|1` | Persist `ln_preimage_hex` into receipts (default `1` when receipts enabled) |
| `--stop-after-ln-pay 0|1` | Testing/recovery hook: stop after paying LN (default `0`) |

##### Price Guard (Fail-Closed)

| Flag | Meaning |
|---|---|
| `--price-guard 0|1` | Enable price guardrails (default `1`) |
| `--price-max-age-ms <n>` | Reject stale snapshots (default `15000`) |
| `--taker-max-discount-bps <n>` | Reject quotes discounted beyond this vs oracle median (default `200`) |

##### Swap Execution (`--run-swap 1`)

| Flag | Meaning |
|---|---|
| `--run-swap 0|1` | Execute the full swap state machine (default `0`) |
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
| `--ln-impl <cln|lnd>` | Lightning implementation (default `cln`) |
| `--ln-backend <docker|cli>` | Lightning backend (default `docker`) |
| `--ln-compose-file <path>` | Docker compose file (default `dev/ln-regtest/docker-compose.yml`) |
| `--ln-service <name>` | Docker service name (required when `--ln-backend docker`) |
| `--ln-network <regtest|signet|mainnet|...>` | Lightning network (default `regtest`) |
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
| `--commitment <processed|confirmed|finalized>` | Commitment (default `confirmed`) |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `keygen` | Create a keypair | `--out <path>`; optional: `--seed-hex <hex32>`, `--force 0|1` |
| `address` | Print pubkey | `--keypair <path>` |
| `balance` | SOL balance | `--keypair <path>` |
| `airdrop` | Devnet/testnet airdrop | `--keypair <path> --sol <n>` |
| `transfer-sol` | Send SOL | `--keypair <path> --to <pubkey> --sol <n>` |
| `mint-create` | Create a test mint | `--keypair <path> --decimals <n>`; optional: `--out <path>` |
| `mint-info` | Inspect mint | `--mint <pubkey>` |
| `token-ata` | Print or create ATA | `--keypair <path> --mint <pubkey>`; optional: `--owner <pubkey>`, `--create 0|1` |
| `token-balance` | SPL token balance | `--keypair <path> --mint <pubkey>`; optional: `--owner <pubkey>` |
| `token-transfer` | Transfer SPL tokens | `--keypair <path> --mint <pubkey> --to <pubkey> --amount <u64>`; optional: `--create-ata 0|1` |
| `mint-to` | Mint test tokens | `--keypair <path> --mint <pubkey> --to <pubkey> --amount <u64>`; optional: `--create-ata 0|1` |
| `inventory` | Print balances across mints | `--keypair <path>`; optional: `--mints <csvPubkeys>` |

---

### Solana Escrow Program Tooling (`escrowctl`)

#### Global Flags

| Flag | Meaning |
|---|---|
| `--solana-rpc-url <url[,url2,...]>` | RPC pool (default `http://127.0.0.1:8899`) |
| `--commitment <processed|confirmed|finalized>` | Commitment (default `confirmed`) |
| `--program-id <base58>` | Override program id (default is the shared program id compiled into the client) |
| `--solana-cu-limit <units>` | Optional compute unit limit |
| `--solana-cu-price <microLamports>` | Optional priority fee |
| `--solana-keypair <path>` | Required for signing commands (`config-init`, `config-set`, withdrawals, trade config init/set) |

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `config-get` | Read platform config | none |
| `config-init` | Initialize platform fee config | `--fee-bps <n>`; optional: `--fee-collector <pubkey>`, `--simulate 0|1` |
| `config-set` | Update platform fee config | `--fee-bps <n>`; optional: `--fee-collector <pubkey>`, `--simulate 0|1` |
| `fees-balance` | Platform fee vault balance | `--mint <pubkey>` |
| `fees-withdraw` | Withdraw platform fees | `--mint <pubkey>`; optional: `--amount <u64>`, `--create-ata 0|1`, `--simulate 0|1` |
| `trade-config-get` | Read trade fee config | `--fee-collector <pubkey>` |
| `trade-config-init` | Initialize trade fee config | `--fee-bps <n>`; optional: `--fee-collector <pubkey>`, `--simulate 0|1` |
| `trade-config-set` | Update trade fee config | `--fee-bps <n>`; optional: `--fee-collector <pubkey>`, `--simulate 0|1` |
| `trade-fees-balance` | Trade fee vault balance | `--fee-collector <pubkey> --mint <pubkey>` |
| `trade-fees-withdraw` | Withdraw trade fees (for the signer fee collector) | `--mint <pubkey>`; optional: `--amount <u64>`, `--create-ata 0|1`, `--simulate 0|1` |
| `escrow-get` | Inspect escrow state | `--payment-hash <hex32>` |

---

### Solana Program Build/Deploy (`solprogctl`) (Maintainers Only)

#### Commands

| Command | What it does | Flags |
|---|---|---|
| `id` | Print the program id used by the codebase | none |
| `build` | Build the SBF program | none (requires Rust + Solana CLI toolchain) |
| `deploy` | Deploy/upgrade the program | Required: `--rpc-url <url> --payer <keypair.json> --program-keypair <keypair.json>`; optional: `--upgrade-authority <keypair.json>`, `--so <path>`, `--dry-run 0|1` |
| `keypair-pubkey` | Print a program pubkey from a keypair file | `--program-keypair <keypair.json>` |

---

### Lightning Operator Tooling (`lnctl`)

#### Global Flags

| Flag | Meaning |
|---|---|
| `--impl <cln|lnd>` | Implementation (default `cln`) |
| `--backend <cli|docker>` | Backend (default `cli`) |
| `--network <bitcoin|mainnet|testnet|regtest|signet>` | Network (default `regtest`) |
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
| `listfunds` | Wallet + channel balances | none |
| `balance` | Alias of listfunds wallet balance | none |
| `connect` | Connect to a peer | `--peer <nodeid@host:port>` |
| `fundchannel` | Open a channel | `--node-id <hex> --amount-sats <n>` |
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
| `init` | Generate `lnd.conf` under `onchain/` | `init --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>] [--alias <str>] [--p2p-port <n>] [--rpc-port <n>] [--rest-port <n>] [--bitcoin-node <neutrino|bitcoind>] [--neutrino-peers <host:port[,..]>] [--wallet-password-file <path>]` |
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
- `peer.keypair`: path to the peer wallet keypair file (usually `stores/<store>/db/keypair.json`) so tools can sign sidechannel envelopes locally
- optional sampling params: `max_tokens`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`
- `sc_bridge.token` or `sc_bridge.token_file`
- `receipts.db` (optional, for `intercomswap_receipts_*` tools)
- `ln.*`, `solana.*` (optional, depending on which tools you want enabled)

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
