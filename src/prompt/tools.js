function tool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

const emptyParams = { type: 'object', additionalProperties: false, properties: {} };

const channelParam = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Sidechannel name (e.g. 0000intercomswapbtcusdt or swap:<id>)',
};

const base64Param = {
  type: 'string',
  minLength: 1,
  maxLength: 16384,
  description: 'Base64-encoded JSON payload',
};

const hex32Param = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-fA-F]{64}$',
};

const base58Param = {
  type: 'string',
  minLength: 32,
  maxLength: 64,
  pattern: '^[1-9A-HJ-NP-Za-km-z]+$',
};

const unixSecParam = { type: 'integer', minimum: 1, description: 'Unix seconds timestamp' };

const atomicAmountParam = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[0-9]+$',
  description: 'Decimal string amount in smallest units (atomic)',
};

const satsParam = { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000, description: 'Satoshis' };

// NOTE: This is a first, safe “tool surface” for prompting.
// The executor (Phase 5B) must validate and *must not* allow arbitrary file paths or shell execution.
export const INTERCOMSWAP_TOOLS = [
  tool(
    'intercomswap_app_info',
    'Get app binding info (app_tag, Solana program id, derived app_hash).',
    emptyParams
  ),
  tool(
    'intercomswap_env_get',
    'Get local environment/config summary (LN network, Solana RPC, receipts DB path). Does not touch the network.',
    emptyParams
  ),
  // SC-Bridge safe RPCs (no CLI mirroring).
  tool('intercomswap_sc_info', 'Get peer info via SC-Bridge (safe fields only).', emptyParams),
  tool('intercomswap_sc_stats', 'Get SC-Bridge stats.', emptyParams),
  tool('intercomswap_sc_price_get', 'Get latest price snapshot from local price feature/oracle.', emptyParams),
  tool('intercomswap_sc_subscribe', 'Subscribe this prompt session to sidechannel message events for specific channels.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: channelParam,
        description: 'Channels to receive events for.',
      },
    },
    required: ['channels'],
  }),
  tool(
    'intercomswap_sc_wait_envelope',
    'Wait for the next signed swap envelope seen on subscribed sidechannels. Returns a handle to the full envelope.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channels: {
          type: 'array',
          minItems: 0,
          maxItems: 50,
          items: channelParam,
          description: 'Optional channel allowlist. If omitted/empty, any subscribed channel is accepted.',
        },
        kinds: {
          type: 'array',
          minItems: 0,
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'Optional swap envelope kind allowlist (e.g. swap.rfq, swap.quote, swap.swap_invite).',
        },
        timeout_ms: { type: 'integer', minimum: 10, maximum: 120000, description: 'Long-poll timeout in ms.' },
      },
      required: [],
    }
  ),
  tool('intercomswap_sc_join', 'Join a sidechannel (invite/welcome optional).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      invite_b64: { ...base64Param, description: 'Optional invite (base64 JSON).' },
      welcome_b64: { ...base64Param, description: 'Optional welcome (base64 JSON).' },
    },
    required: ['channel'],
  }),
  tool('intercomswap_sc_join_many', 'Join multiple sidechannels (public rendezvous style).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: channelParam,
        description: 'Channels to join.',
      },
    },
    required: ['channels'],
  }),
  tool('intercomswap_sc_leave', 'Leave a sidechannel locally (channel hygiene).', {
    type: 'object',
    additionalProperties: false,
    properties: { channel: channelParam },
    required: ['channel'],
  }),
  tool('intercomswap_sc_leave_many', 'Leave multiple sidechannels locally (channel hygiene).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: channelParam,
        description: 'Channels to leave.',
      },
    },
    required: ['channels'],
  }),
  tool('intercomswap_sc_open', 'Request/open a sidechannel via an entry channel (invite/welcome optional).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      via: { ...channelParam, description: 'Entry/rendezvous channel to send the open request through.' },
      invite_b64: { ...base64Param, description: 'Optional invite (base64 JSON).' },
      welcome_b64: { ...base64Param, description: 'Optional welcome (base64 JSON).' },
    },
    required: ['channel', 'via'],
  }),
  tool('intercomswap_sc_send_text', 'Send a plain text message to a channel.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      text: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['channel', 'text'],
  }),
  tool('intercomswap_sc_send_json', 'Send a JSON message to a channel (structured payload).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      json: { type: 'object' },
    },
    required: ['channel', 'json'],
  }),

  // Peer lifecycle (local pear run supervisor; does not grant shell access).
  tool('intercomswap_peer_status', 'List local peer instances started via prompt tools (reads onchain/peers).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional peer instance id.' },
    },
    required: [],
  }),
  tool('intercomswap_peer_start', 'Start a local peer instance (detached pear run process).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      store: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      sc_port: { type: 'integer', minimum: 1, maximum: 65535 },
      sidechannels: { type: 'array', minItems: 0, maxItems: 50, items: channelParam, description: 'Extra sidechannels to join on startup.' },
      inviter_keys: { type: 'array', minItems: 0, maxItems: 25, items: hex32Param, description: 'Trusted inviter peer pubkeys (hex32).' },
      dht_bootstrap: {
        type: 'array',
        minItems: 0,
        maxItems: 25,
        items: { type: 'string', minLength: 3, maxLength: 200, pattern: '^[^\\s]+$' },
        description: 'Optional HyperDHT bootstrap nodes (host:port or ip@host:port).',
      },
      msb_dht_bootstrap: {
        type: 'array',
        minItems: 0,
        maxItems: 25,
        items: { type: 'string', minLength: 3, maxLength: 200, pattern: '^[^\\s]+$' },
        description: 'Optional MSB HyperDHT bootstrap nodes (host:port or ip@host:port).',
      },
      subnet_channel: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\s]+$' },
      msb_enabled: { type: 'boolean' },
      price_oracle_enabled: { type: 'boolean' },
      pow_enabled: { type: 'boolean' },
      pow_difficulty: { type: 'integer', minimum: 0, maximum: 32 },
      welcome_required: { type: 'boolean' },
      invite_required: { type: 'boolean' },
      invite_prefixes: {
        type: 'array',
        minItems: 0,
        maxItems: 25,
        items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s]+$' },
      },
      log_path: { type: 'string', minLength: 1, maxLength: 400, description: 'Optional log path (must be under onchain/).' },
      ready_timeout_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for SC-Bridge port to open (default 15000ms).' },
    },
    required: ['name', 'store', 'sc_port'],
  }),
  tool('intercomswap_peer_stop', 'Stop a local peer instance (by instance name).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      signal: { type: 'string', minLength: 3, maxLength: 10, description: 'SIGTERM|SIGINT|SIGKILL (default SIGTERM)' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait time before SIGKILL fallback (default 2000ms).' },
    },
    required: ['name'],
  }),
  tool('intercomswap_peer_restart', 'Restart a local peer instance (stop then start using last config).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait time before SIGKILL fallback (default 2000ms).' },
      ready_timeout_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for SC-Bridge port to open (default 15000ms).' },
    },
    required: ['name'],
  }),

  // RFQ / swap envelope helpers (Phase 5B executor will translate to swapctl+sign safely).
  tool('intercomswap_rfq_post', 'Post a signed RFQ envelope into an RFQ rendezvous channel.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      max_platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500, description: 'Optional fee ceiling for platform fee (bps).' },
      max_trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Optional fee ceiling for trade fee (bps).' },
      max_total_fee_bps: { type: 'integer', minimum: 0, maximum: 1500, description: 'Optional ceiling for platform+trade fee (bps).' },
      min_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Optional minimum Solana refund/claim window in seconds.' },
      max_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Optional maximum Solana refund/claim window in seconds.' },
      valid_until_unix: { ...unixSecParam, description: 'Optional expiry for the RFQ (unix seconds).' },
    },
    required: ['channel', 'trade_id', 'btc_sats', 'usdt_amount'],
  }),
  tool(
    'intercomswap_quote_post',
    'Post a signed QUOTE envelope into an RFQ channel (references an RFQ id). Provide either valid_until_unix or valid_for_sec.',
    {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      rfq_id: hex32Param,
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      trade_fee_collector: base58Param,
      platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config fee collector.' },
      sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Solana refund/claim window (seconds) that will be used in binding TERMS.' },
      valid_until_unix: unixSecParam,
      valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['channel', 'trade_id', 'rfq_id', 'btc_sats', 'usdt_amount', 'platform_fee_bps', 'trade_fee_bps', 'trade_fee_collector'],
  }
  ),
  tool(
    'intercomswap_quote_post_from_rfq',
    'Maker: post a signed QUOTE that matches an RFQ envelope (no manual rfq_id/btc_sats/usdt_amount required). Provide either valid_until_unix or valid_for_sec.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        rfq_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed RFQ envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an RFQ envelope.' },
          ],
        },
        platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
        trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        trade_fee_collector: base58Param,
        platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config fee collector.' },
        sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Solana refund/claim window (seconds) that will be used in binding TERMS.' },
        valid_until_unix: unixSecParam,
        valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
      },
      required: ['channel', 'rfq_envelope', 'platform_fee_bps', 'trade_fee_bps', 'trade_fee_collector'],
    }
  ),
  tool('intercomswap_quote_accept', 'Post a signed QUOTE_ACCEPT envelope into the RFQ channel (accept a quote).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      quote_envelope: {
        anyOf: [
          { type: 'object', description: 'Full signed quote envelope received from the network.' },
          { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a quote envelope.' },
        ],
      },
    },
    required: ['channel', 'quote_envelope'],
  }),
  tool(
    'intercomswap_swap_invite_from_accept',
    'Maker: generate welcome+invite and post SWAP_INVITE into the RFQ channel, based on an accepted quote.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        accept_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed QUOTE_ACCEPT envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an accept envelope.' },
          ],
        },
        swap_channel: { ...channelParam, description: 'Optional explicit swap:<id> channel name. If omitted, derived.' },
        welcome_text: { type: 'string', minLength: 1, maxLength: 500 },
        ttl_sec: { type: 'integer', minimum: 30, maximum: 60 * 60 * 24 * 7 },
      },
      required: ['channel', 'accept_envelope', 'welcome_text'],
    }
  ),
  tool('intercomswap_join_from_swap_invite', 'Taker: join swap:<id> channel using SWAP_INVITE envelope.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      swap_invite_envelope: {
        anyOf: [
          { type: 'object', description: 'Full signed SWAP_INVITE envelope received from maker.' },
          { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a swap invite envelope.' },
        ],
      },
    },
    required: ['swap_invite_envelope'],
  }),

  // RFQ bot manager (local processes; does not stop the peer).
  tool('intercomswap_rfqbot_status', 'List local RFQ bot instances started via prompt tools (reads onchain/rfq-bots).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional bot instance id.' },
    },
    required: [],
  }),
  tool('intercomswap_rfqbot_start_maker', 'Start a maker RFQ bot instance (detached background process).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      store: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      sc_port: { type: 'integer', minimum: 1, maximum: 65535 },
      receipts_db: { type: 'string', minLength: 1, maxLength: 400, description: 'Optional receipts db path (must be under onchain/).' },
      argv: {
        type: 'array',
        minItems: 0,
        maxItems: 80,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'Optional extra args passed to scripts/rfq-maker.mjs (no shell).',
      },
    },
    required: ['name', 'store', 'sc_port'],
  }),
  tool('intercomswap_rfqbot_start_taker', 'Start a taker RFQ bot instance (detached background process).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      store: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      sc_port: { type: 'integer', minimum: 1, maximum: 65535 },
      receipts_db: { type: 'string', minLength: 1, maxLength: 400, description: 'Optional receipts db path (must be under onchain/).' },
      argv: {
        type: 'array',
        minItems: 0,
        maxItems: 80,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'Optional extra args passed to scripts/rfq-taker.mjs (no shell).',
      },
    },
    required: ['name', 'store', 'sc_port'],
  }),
  tool('intercomswap_rfqbot_stop', 'Stop an RFQ bot instance (by instance name).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      signal: { type: 'string', minLength: 3, maxLength: 10, description: 'SIGTERM|SIGINT|SIGKILL (default SIGTERM)' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait time before SIGKILL fallback (default 2000ms).' },
    },
    required: ['name'],
  }),
  tool('intercomswap_rfqbot_restart', 'Restart an RFQ bot instance (stop then start using last config).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait time before SIGKILL fallback (default 2000ms).' },
    },
    required: ['name'],
  }),

  tool('intercomswap_terms_post', 'Maker: post signed TERMS envelope inside swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      sol_mint: base58Param,
      sol_recipient: base58Param,
      sol_refund: base58Param,
      sol_refund_after_unix: unixSecParam,
      ln_receiver_peer: hex32Param,
      ln_payer_peer: hex32Param,
      platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      trade_fee_collector: base58Param,
      platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config fee collector.' },
      terms_valid_until_unix: { ...unixSecParam, description: 'Optional expiry for terms acceptance.' },
    },
    required: [
      'channel',
      'trade_id',
      'btc_sats',
      'usdt_amount',
      'sol_mint',
      'sol_recipient',
      'sol_refund',
      'sol_refund_after_unix',
      'ln_receiver_peer',
      'ln_payer_peer',
      'platform_fee_bps',
      'trade_fee_bps',
      'trade_fee_collector',
    ],
  }),
  tool('intercomswap_terms_accept', 'Taker: post signed ACCEPT inside swap:<id> referencing the terms hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      terms_hash_hex: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
    },
    required: ['channel', 'trade_id', 'terms_hash_hex'],
  }),
  tool(
    'intercomswap_terms_accept_from_terms',
    'Taker: post signed ACCEPT inside swap:<id> from a TERMS envelope (computes terms hash).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        terms_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed TERMS envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a TERMS envelope.' },
          ],
        },
      },
      required: ['channel', 'terms_envelope'],
    }
  ),

  // Lightning (LN) operator actions (executor must use configured backend/credentials).
  tool('intercomswap_ln_docker_ps', 'Docker-only: show docker compose service status for the configured LN compose stack.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Optional override (must be within repo root).
      compose_file: { type: 'string', minLength: 1, maxLength: 400, pattern: '^[^\\s]+$' },
    },
    required: [],
  }),
  tool('intercomswap_ln_docker_up', 'Docker-only: start LN docker services (defaults to bitcoind + configured LN service).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      services: {
        type: 'array',
        minItems: 0,
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        description: 'Optional docker compose service names. If omitted, uses defaults.',
      },
      // Optional override (must be within repo root).
      compose_file: { type: 'string', minLength: 1, maxLength: 400, pattern: '^[^\\s]+$' },
    },
    required: [],
  }),
  tool('intercomswap_ln_docker_down', 'Docker-only: stop the LN docker compose stack.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Optional override (must be within repo root).
      compose_file: { type: 'string', minLength: 1, maxLength: 400, pattern: '^[^\\s]+$' },
      volumes: { type: 'boolean', description: 'If true, also remove named volumes (DANGEROUS; deletes regtest state).' },
    },
    required: [],
  }),
  tool('intercomswap_ln_info', 'Get Lightning node info (impl/backend configured locally).', emptyParams),
  tool('intercomswap_ln_newaddr', 'Get a new on-chain BTC address from the LN node wallet.', emptyParams),
  tool('intercomswap_ln_listfunds', 'Get on-chain + channel balances.', emptyParams),
  tool('intercomswap_ln_withdraw', 'Send on-chain BTC from the LN node wallet to a BTC address.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      address: { type: 'string', minLength: 10, maxLength: 200, description: 'Destination BTC address (bech32 recommended).' },
      amount_sats: { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000, description: 'Satoshis to send.' },
      sat_per_vbyte: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Optional fee rate for on-chain send.' },
    },
    required: ['address', 'amount_sats'],
  }),
  tool('intercomswap_ln_connect', 'Connect to a Lightning peer (nodeid@host:port).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      peer: { type: 'string', minLength: 10, maxLength: 200, description: 'nodeid@host:port' },
    },
    required: ['peer'],
  }),
  tool('intercomswap_ln_fundchannel', 'Open a Lightning channel to a peer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      node_id: { type: 'string', minLength: 66, maxLength: 66, pattern: '^[0-9a-fA-F]{66}$' },
      amount_sats: { type: 'integer', minimum: 1_000, maximum: 10_000_000_000 },
      private: { type: 'boolean', description: 'Prefer private channels for swaps.' },
    },
    required: ['node_id', 'amount_sats'],
  }),
  tool('intercomswap_ln_invoice_create', 'Create a standard BOLT11 invoice (no hodl invoices).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      amount_msat: { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000 * 1000 },
      label: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      expiry_sec: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['amount_msat', 'label', 'description'],
  }),
  tool('intercomswap_ln_decodepay', 'Decode a BOLT11 invoice offline.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
    },
    required: ['bolt11'],
  }),
  tool('intercomswap_ln_pay', 'Pay a BOLT11 invoice.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
    },
    required: ['bolt11'],
  }),
  tool('intercomswap_ln_pay_status', 'Query payment status by payment_hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
    },
    required: ['payment_hash_hex'],
  }),
  tool('intercomswap_ln_preimage_get', 'Get a payment preimage by payment_hash (for recovery).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
    },
    required: ['payment_hash_hex'],
  }),

  // Swap settlement helpers (deterministic; sign + send swap envelopes).
  tool('intercomswap_swap_ln_invoice_create_and_post', 'Maker: create an LN invoice and post LN_INVOICE into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      label: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      expiry_sec: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['channel', 'trade_id', 'btc_sats', 'label', 'description'],
  }),
  tool(
    'intercomswap_swap_sol_escrow_init_and_post',
    'Maker: init Solana escrow and post SOL_ESCROW_CREATED into swap:<id>.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        trade_id: { type: 'string', minLength: 1, maxLength: 128 },
        payment_hash_hex: hex32Param,
        mint: base58Param,
        amount: atomicAmountParam,
        recipient: base58Param,
        refund: base58Param,
        refund_after_unix: unixSecParam,
        platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
        trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        trade_fee_collector: base58Param,
      },
      required: [
        'channel',
        'trade_id',
        'payment_hash_hex',
        'mint',
        'amount',
        'recipient',
        'refund',
        'refund_after_unix',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
      ],
    }
  ),
  tool(
    'intercomswap_swap_verify_pre_pay',
    'Taker: verify (terms + LN invoice + Sol escrow) and validate the escrow exists on-chain before paying.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        terms_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed TERMS envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a TERMS envelope.' },
          ],
        },
        invoice_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed LN_INVOICE envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an LN_INVOICE envelope.' },
          ],
        },
        escrow_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed SOL_ESCROW_CREATED envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a SOL_ESCROW_CREATED envelope.' },
          ],
        },
        now_unix: { ...unixSecParam, description: 'Optional unix seconds for expiry checks; defaults to now.' },
      },
      required: ['terms_envelope', 'invoice_envelope', 'escrow_envelope'],
    }
  ),
  tool('intercomswap_swap_ln_pay_and_post', 'Taker: pay the LN invoice and post LN_PAID into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
      payment_hash_hex: hex32Param,
    },
    required: ['channel', 'trade_id', 'bolt11', 'payment_hash_hex'],
  }),
  tool(
    'intercomswap_swap_ln_pay_and_post_from_invoice',
    'Taker: pay an LN invoice from an LN_INVOICE envelope and post LN_PAID into swap:<id> (no manual bolt11/payment_hash copying).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        invoice_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed LN_INVOICE envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an LN_INVOICE envelope.' },
          ],
        },
      },
      required: ['channel', 'invoice_envelope'],
    }
  ),
  tool(
    'intercomswap_swap_ln_pay_and_post_verified',
    'Taker: verify (terms + invoice + escrow on-chain), then pay the LN invoice and post LN_PAID into swap:<id>.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        terms_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed TERMS envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a TERMS envelope.' },
          ],
        },
        invoice_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed LN_INVOICE envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an LN_INVOICE envelope.' },
          ],
        },
        escrow_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed SOL_ESCROW_CREATED envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a SOL_ESCROW_CREATED envelope.' },
          ],
        },
        now_unix: { ...unixSecParam, description: 'Optional unix seconds for expiry checks; defaults to now.' },
      },
      required: ['channel', 'terms_envelope', 'invoice_envelope', 'escrow_envelope'],
    }
  ),
  tool('intercomswap_swap_sol_claim_and_post', 'Taker: claim Solana escrow and post SOL_CLAIMED into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      preimage_hex: {
        anyOf: [
          { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
          { type: 'string', minLength: 8, maxLength: 200, pattern: '^secret:[0-9a-fA-F-]+$' },
        ],
      },
      mint: base58Param,
    },
    required: ['channel', 'trade_id', 'preimage_hex', 'mint'],
  }),

  // Solana wallet operator actions (local keys only; signer configured in prompt setup JSON unless otherwise noted).
  tool(
    'intercomswap_sol_local_status',
    'Local-only: show whether a solana-test-validator RPC is listening on the configured localhost port (and whether it was started by this repo).',
    emptyParams
  ),
  tool(
    'intercomswap_sol_local_start',
    'Local-only: start solana-test-validator with the escrow program loaded (writes ledger/logs under onchain/).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        rpc_port: { type: 'integer', minimum: 1, maximum: 65535, description: 'RPC port (default: from solana.rpc_url or 8899).' },
        faucet_port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Faucet port (default: 9900).' },
        ledger_dir: { type: 'string', minLength: 1, maxLength: 400, description: 'Ledger dir (must be under onchain/).' },
        so_path: { type: 'string', minLength: 1, maxLength: 400, description: 'Program .so path (must be within repo root).' },
        program_id: { ...base58Param, description: 'Program id to load (default: shared LN_USDT_ESCROW_PROGRAM_ID).' },
        reset: { type: 'boolean', description: 'Reset ledger (default false).' },
        quiet: { type: 'boolean', description: 'Quiet logs (default true).' },
        ready_timeout_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for RPC port to be ready (default 60000).' },
      },
      required: [],
    }
  ),
  tool('intercomswap_sol_local_stop', 'Local-only: stop the managed solana-test-validator process.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      signal: { type: 'string', minLength: 3, maxLength: 10, description: 'SIGINT|SIGTERM|SIGKILL (default SIGINT).' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wait for exit (default 5000).' },
    },
    required: [],
  }),
  tool('intercomswap_sol_signer_pubkey', 'Get the configured Solana signer pubkey for this promptd instance.', emptyParams),
  tool('intercomswap_sol_keygen', 'Generate a new Solana keypair JSON file under onchain/ (gitignored).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      out: { type: 'string', minLength: 1, maxLength: 400, description: 'Output path (must be under onchain/).' },
      seed_hex: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$', description: 'Optional 32-byte hex seed for deterministic keygen.' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing file (default false).' },
    },
    required: ['out'],
  }),
  tool('intercomswap_sol_keypair_pubkey', 'Get the pubkey for a Solana keypair JSON file (path must be under onchain/).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      keypair_path: { type: 'string', minLength: 1, maxLength: 400, description: 'Keypair JSON path (must be under onchain/).' },
    },
    required: ['keypair_path'],
  }),
  tool('intercomswap_sol_airdrop', 'Request an airdrop (local validator/test only; mainnet will fail).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      pubkey: { ...base58Param, description: 'Optional; defaults to signer pubkey.' },
      lamports: atomicAmountParam,
    },
    required: ['lamports'],
  }),
  tool('intercomswap_sol_transfer_sol', 'Transfer SOL from the configured signer to a recipient pubkey.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      to: base58Param,
      lamports: atomicAmountParam,
    },
    required: ['to', 'lamports'],
  }),
  tool('intercomswap_sol_token_transfer', 'Transfer an SPL token (ATA->ATA) from the signer to a recipient owner pubkey.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      mint: base58Param,
      to_owner: base58Param,
      amount: atomicAmountParam,
      create_ata: { type: 'boolean', description: 'Create recipient ATA if missing (default true).' },
    },
    required: ['mint', 'to_owner', 'amount'],
  }),
  tool('intercomswap_sol_mint_create', 'Create a new SPL mint where the signer is mint+freeze authority (test/dev convenience).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      decimals: { type: 'integer', minimum: 0, maximum: 18 },
    },
    required: ['decimals'],
  }),
  tool('intercomswap_sol_mint_to', 'Mint SPL tokens from a signer-controlled mint to a recipient owner pubkey (test/dev convenience).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      mint: base58Param,
      to_owner: base58Param,
      amount: atomicAmountParam,
      create_ata: { type: 'boolean', description: 'Create recipient ATA if missing (default true).' },
    },
    required: ['mint', 'to_owner', 'amount'],
  }),

  // Solana escrow / program ops (executor must use configured RPC + keypairs).
  tool('intercomswap_sol_balance', 'Get SOL balance for a pubkey.', {
    type: 'object',
    additionalProperties: false,
    properties: { pubkey: base58Param },
    required: ['pubkey'],
  }),
  tool('intercomswap_sol_token_balance', 'Get SPL token balance for a (owner,mint) pair (ATA).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      owner: base58Param,
      mint: base58Param,
    },
    required: ['owner', 'mint'],
  }),
  tool('intercomswap_sol_escrow_get', 'Fetch escrow state by payment_hash (and mint).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
    },
    required: ['payment_hash_hex', 'mint'],
  }),
  tool('intercomswap_sol_escrow_init', 'Initialize an escrow locked to LN payment_hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
      amount: atomicAmountParam,
      recipient: base58Param,
      refund: base58Param,
      refund_after_unix: unixSecParam,
      platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      trade_fee_collector: base58Param,
      platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config.' },
    },
    required: [
      'payment_hash_hex',
      'mint',
      'amount',
      'recipient',
      'refund',
      'refund_after_unix',
      'platform_fee_bps',
      'trade_fee_bps',
      'trade_fee_collector',
    ],
  }),
  tool('intercomswap_sol_escrow_claim', 'Claim escrow by submitting LN preimage (recipient signature required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      preimage_hex: {
        anyOf: [
          { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
          { type: 'string', minLength: 8, maxLength: 200, pattern: '^secret:[0-9a-fA-F-]+$' },
        ],
        description: '32-byte hex preimage, or a secret handle returned by promptd (secret:<id>).',
      },
      mint: base58Param,
    },
    required: ['preimage_hex', 'mint'],
  }),
  tool('intercomswap_sol_escrow_refund', 'Refund escrow after timeout (refund signature required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
    },
    required: ['payment_hash_hex', 'mint'],
  }),
  tool('intercomswap_sol_config_get', 'Get program fee config (platform config PDA).', emptyParams),
  tool('intercomswap_sol_config_set', 'Set program fee config (admin authority required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      fee_collector: base58Param,
    },
    required: ['fee_bps', 'fee_collector'],
  }),
  tool('intercomswap_sol_fees_withdraw', 'Withdraw accrued platform fees from fee vault (admin authority required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      mint: base58Param,
      to: base58Param,
      amount: atomicAmountParam,
    },
    required: ['mint', 'to', 'amount'],
  }),

  tool(
    'intercomswap_sol_trade_config_get',
    'Get trade fee config (per fee_collector).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        fee_collector: base58Param,
      },
      required: ['fee_collector'],
    }
  ),
  tool(
    'intercomswap_sol_trade_config_set',
    'Init/set trade fee config (fee_collector authority required).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        fee_collector: base58Param,
      },
      required: ['fee_bps', 'fee_collector'],
    }
  ),
  tool(
    'intercomswap_sol_trade_fees_withdraw',
    'Withdraw accrued trade fees for the configured fee_collector.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mint: base58Param,
        to: base58Param,
        amount: atomicAmountParam,
      },
      required: ['mint', 'to', 'amount'],
    }
  ),

  // Receipts / recovery (local-only, deterministic).
  tool('intercomswap_receipts_list', 'List local trade receipts (sqlite).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    },
    required: [],
  }),
  tool('intercomswap_receipts_show', 'Show a local receipt by trade_id.', {
    type: 'object',
    additionalProperties: false,
    properties: { trade_id: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['trade_id'],
  }),
  tool('intercomswap_receipts_list_open_claims', 'List trades that look claimable (state=ln_paid and preimage present).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    },
    required: [],
  }),
  tool(
    'intercomswap_receipts_list_open_refunds',
    'List trades that look refundable (state=escrow and refund_after <= now). Uses local receipt data only.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        now_unix: { ...unixSecParam, description: 'Optional unix seconds; defaults to now.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
      },
      required: [],
    }
  ),
  tool('intercomswap_swaprecover_claim', 'Recover: claim a stuck Solana escrow using local receipts + signer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      payment_hash_hex: hex32Param,
    },
    required: [],
  }),
  tool('intercomswap_swaprecover_refund', 'Recover: refund an expired Solana escrow using local receipts + signer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      payment_hash_hex: hex32Param,
    },
    required: [],
  }),
];
