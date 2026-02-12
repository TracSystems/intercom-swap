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

const solCuLimitParam = {
  type: 'integer',
  minimum: 0,
  maximum: 1_400_000,
  description: 'Optional Solana compute unit limit override (0/omit uses instance default).',
};

const solCuPriceParam = {
  type: 'integer',
  minimum: 0,
  maximum: 1_000_000_000,
  description: 'Optional Solana compute unit price override in micro-lamports (priority fee). 0/omit uses instance default.',
};

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
  tool(
    'intercomswap_stack_start',
    'Start/bootstrap the local stack (peer + SC-Bridge, LN regtest channel on docker, Solana local validator, receipts DB).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Peer + SC-Bridge
        peer_name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        peer_store: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        sc_port: { type: 'integer', minimum: 1, maximum: 65535 },
        sidechannels: {
          type: 'array',
          minItems: 0,
          maxItems: 50,
          items: channelParam,
          description: 'Sidechannels to join on startup (rendezvous).',
        },
        // LN + Solana
        ln_bootstrap: { type: 'boolean', description: 'If true, ensure LN readiness (docker+regtest: fund + open channel if needed).' },
        sol_bootstrap: { type: 'boolean', description: 'If true, ensure Solana readiness (localhost: start validator if needed).' },
      },
      required: [],
    }
  ),
  tool(
    'intercomswap_stack_stop',
    'Stop the local stack (peer + Solana local validator + LN docker). Does not delete state.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer_name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        sc_port: { type: 'integer', minimum: 1, maximum: 65535 },
        ln_stop: { type: 'boolean', description: 'If true and ln.backend=docker, stop the docker compose stack.' },
        sol_stop: { type: 'boolean', description: 'If true and Solana is localhost, stop the managed local validator.' },
      },
      required: [],
    }
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
  tool(
    'intercomswap_offer_post',
    'Post a signed Offer announcement (swap.svc_announce) into rendezvous channels (advertise: have USDT, want BTC; prompts BTC sellers to post matching RFQs).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channels: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: channelParam,
          description: 'Rendezvous channels to broadcast the offer announcement into.',
        },
        trade_id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Optional stable id for the announcement. If omitted, derived from name.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Short label shown to peers (example: "maker:alice").',
        },
        rfq_channels: {
          type: 'array',
          minItems: 0,
          maxItems: 20,
          items: channelParam,
          description: 'Where BTC sellers should post the matching RFQ (defaults to the same channels).',
        },
        ttl_sec: {
          type: 'integer',
          minimum: 10,
          maximum: 7 * 24 * 3600,
          description: 'Optional TTL for the announcement (seconds). Used to compute valid_until_unix.',
        },
        valid_until_unix: { ...unixSecParam, description: 'Optional expiry for the announcement (unix seconds).' },
        offers: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Structured offers. These mirror RFQ fields so a seller can post an RFQ with minimal back-and-forth.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pair: { type: 'string', enum: ['BTC_LN/USDT_SOL'] },
              have: { type: 'string', enum: ['USDT_SOL'] },
              want: { type: 'string', enum: ['BTC_LN'] },
              btc_sats: satsParam,
              usdt_amount: atomicAmountParam,
              max_platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
              max_trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
              max_total_fee_bps: { type: 'integer', minimum: 0, maximum: 1500 },
              min_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600 },
              max_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600 },
            },
            required: [
              'pair',
              'have',
              'want',
              'btc_sats',
              'usdt_amount',
              'max_platform_fee_bps',
              'max_trade_fee_bps',
              'max_total_fee_bps',
              'min_sol_refund_window_sec',
              'max_sol_refund_window_sec',
            ],
          },
        },
      },
      required: ['channels', 'name', 'offers'],
    }
  ),
  tool('intercomswap_rfq_post', 'Post a signed RFQ envelope into an RFQ rendezvous channel (BTC_LN->USDT_SOL: sell BTC for USDT).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      sol_recipient: {
        ...base58Param,
        description: 'Optional Solana recipient pubkey for USDT settlement. Recommended/required for full auto swap settlement.',
      },
      max_platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500, description: 'Optional fee ceiling for platform fee (bps).' },
      max_trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Optional fee ceiling for trade fee (bps).' },
      max_total_fee_bps: { type: 'integer', minimum: 0, maximum: 1500, description: 'Optional ceiling for platform+trade fee (bps).' },
      min_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Optional minimum Solana refund/claim window in seconds.' },
      max_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Optional maximum Solana refund/claim window in seconds.' },
      valid_until_unix: { ...unixSecParam, description: 'Optional expiry for the RFQ (unix seconds).' },
      ln_liquidity_mode: {
        type: 'string',
        enum: ['single_channel', 'aggregate'],
        description:
          'Lightning outbound liquidity guardrail mode. single_channel (default) requires one active channel to cover btc_sats; aggregate allows sum across active channels.',
      },
    },
    required: ['channel', 'trade_id', 'btc_sats', 'usdt_amount'],
  }),
  tool(
    'intercomswap_quote_post',
    'Post a signed QUOTE envelope into an RFQ channel (references an RFQ id). Fees are read from on-chain config/trade-config (not negotiated). Provide either valid_until_unix or valid_for_sec.',
    {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      rfq_id: hex32Param,
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      trade_fee_collector: { ...base58Param, description: 'Fee receiver pubkey. trade_fee_bps is read from the trade-config PDA for this address.' },
      sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Solana refund/claim window (seconds) that will be used in binding TERMS.' },
      valid_until_unix: unixSecParam,
      valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['channel', 'trade_id', 'rfq_id', 'btc_sats', 'usdt_amount', 'trade_fee_collector'],
  }
  ),
  tool(
    'intercomswap_quote_post_from_rfq',
    'Maker: post a signed QUOTE that matches an RFQ envelope (no manual rfq_id/btc_sats/usdt_amount required). Fees are read from on-chain config/trade-config (not negotiated). Provide either valid_until_unix or valid_for_sec.',
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
        trade_fee_collector: { ...base58Param, description: 'Fee receiver pubkey. trade_fee_bps is read from the trade-config PDA for this address.' },
        sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 7 * 24 * 3600, description: 'Solana refund/claim window (seconds) that will be used in binding TERMS.' },
        valid_until_unix: unixSecParam,
        valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
      },
      required: ['channel', 'rfq_envelope', 'trade_fee_collector'],
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
      ln_liquidity_mode: {
        type: 'string',
        enum: ['single_channel', 'aggregate'],
        description:
          'Lightning outbound liquidity guardrail mode before accepting the quote. single_channel (default) requires one active channel to cover btc_sats; aggregate allows sum across active channels.',
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
        quote_envelope: {
          anyOf: [
            { type: 'object', description: 'Optional signed QUOTE envelope for strict cross-check against accept.quote_id.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Optional secret handle to a quote envelope.' },
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

  // Backend multi-trade automation worker (server-side; replaces client-side orchestration).
  tool('intercomswap_tradeauto_status', 'Get backend trade-automation worker status and memory counters.', emptyParams),
  tool('intercomswap_tradeauto_trace_set', 'Enable/disable backend trade-automation trace emission (off by default).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      trace_enabled: { type: 'boolean' },
    },
    required: ['trace_enabled'],
  }),
  tool('intercomswap_tradeauto_start', 'Start backend multi-trade automation worker for subscribed sidechannels.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: channelParam,
        description: 'Rendezvous channels to monitor (defaults to 0000intercomswapbtcusdt when omitted).',
      },
      interval_ms: { type: 'integer', minimum: 250, maximum: 10000, description: 'Worker tick interval.' },
      max_events: { type: 'integer', minimum: 200, maximum: 4000, description: 'In-memory SC event cap.' },
      max_trades: { type: 'integer', minimum: 10, maximum: 500, description: 'Max active trades evaluated per tick.' },
      event_max_age_ms: { type: 'integer', minimum: 30000, maximum: 3600000, description: 'Ignore stale events older than this.' },
      tool_timeout_ms: { type: 'integer', minimum: 250, maximum: 120000, description: 'Per-tool timeout inside trade automation worker.' },
      sc_ensure_interval_ms: { type: 'integer', minimum: 500, maximum: 60000, description: 'How often the worker reasserts SC subscriptions/reconnect.' },
      hygiene_interval_ms: { type: 'integer', minimum: 1000, maximum: 60000, description: 'How often backend hygiene scans joined swap channels for stale auto-leave.' },
      default_sol_refund_window_sec: { type: 'integer', minimum: 3600, maximum: 604800, description: 'Default Solana refund window used by auto-quote/terms.' },
      welcome_ttl_sec: { type: 'integer', minimum: 30, maximum: 604800, description: 'Invite TTL used for auto-invites.' },
      terms_replay_cooldown_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Cooldown between maker terms replays before accept arrives.' },
      terms_replay_max: { type: 'integer', minimum: 1, maximum: 500, description: 'Max maker terms replay attempts per trade (bounded liveness).' },
      swap_auto_leave_cooldown_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Cooldown between backend stale swap-channel leave retries.' },
      swap_auto_leave_max_attempts: { type: 'integer', minimum: 1, maximum: 50, description: 'Max backend stale swap-channel leave attempts per trade.' },
      waiting_terms_trace_cooldown_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'How often waiting_terms trace entries are emitted per trade.' },
      waiting_terms_ping_cooldown_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Cooldown between taker waiting-terms recovery pings/replays.' },
      waiting_terms_max_pings: { type: 'integer', minimum: 0, maximum: 500, description: 'Max taker waiting-terms recovery pings/replays per trade.' },
      waiting_terms_max_wait_ms: { type: 'integer', minimum: 5000, maximum: 3600000, description: 'Max taker wait for TERMS before timeout handling starts.' },
      waiting_terms_leave_on_timeout: { type: 'boolean', description: 'Whether taker auto-leaves stale swap channel after waiting-terms timeout.' },
      ln_pay_fail_leave_attempts: { type: 'integer', minimum: 2, maximum: 50, description: 'Deterministic threshold: auto-leave swap channel only after this many ln_pay failures for same trade.' },
      ln_pay_fail_leave_min_wait_ms: { type: 'integer', minimum: 1000, maximum: 3600000, description: 'Deterministic threshold: auto-leave only after this much elapsed time since first ln_pay failure.' },
      ln_pay_retry_cooldown_ms: { type: 'integer', minimum: 250, maximum: 120000, description: 'Cooldown between ln_pay retries before thresholds are reached.' },
      trace_enabled: { type: 'boolean', description: 'Enable verbose in-worker trace events (disabled by default).' },
      ln_liquidity_mode: { type: 'string', enum: ['single_channel', 'aggregate'] },
      usdt_mint: base58Param,
      enable_quote_from_offers: { type: 'boolean' },
      enable_quote_from_rfqs: { type: 'boolean', description: 'Quote actionable RFQs even when no local offer line matched.' },
      enable_accept_quotes: { type: 'boolean' },
      enable_invite_from_accepts: { type: 'boolean' },
      enable_join_invites: { type: 'boolean' },
      enable_settlement: { type: 'boolean' },
      sol_cu_limit: solCuLimitParam,
      sol_cu_price: solCuPriceParam,
    },
    required: [],
  }),
  tool('intercomswap_tradeauto_stop', 'Stop backend multi-trade automation worker.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: [],
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

  // Autopost (simple periodic offer/rfq broadcast; in-process scheduler).
  tool('intercomswap_autopost_status', 'List in-process autopost jobs started via tools (offer/rfq repost schedulers).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$', description: 'Optional job id.' },
    },
    required: [],
  }),
  tool('intercomswap_autopost_start', 'Start a periodic repost scheduler for offer_post or rfq_post.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      tool: { type: 'string', enum: ['intercomswap_offer_post', 'intercomswap_rfq_post'] },
      interval_sec: { type: 'integer', minimum: 5, maximum: 86400, description: 'How often to repost.' },
      ttl_sec: {
        type: 'integer',
        minimum: 10,
        maximum: 7 * 24 * 3600,
        description:
          'Absolute validity horizon (seconds) for the offer/RFQ. Autopost stops once expired; reposts do not extend validity.',
      },
      valid_until_unix: {
        ...unixSecParam,
        description:
          'Optional absolute expiry (unix seconds). If provided, autopost will stop at this time and all reposts will share the same valid_until_unix.',
      },
      args: { type: 'object', additionalProperties: true, description: 'Arguments for the selected tool.' },
    },
    required: ['name', 'tool', 'interval_sec', 'ttl_sec', 'args'],
  }),
  tool('intercomswap_autopost_stop', 'Stop an autopost job (by name).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
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
      trade_fee_collector: { ...base58Param, description: 'Fee receiver pubkey. trade_fee_bps is read from the trade-config PDA for this address.' },
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
  tool('intercomswap_swap_status_post', 'Post signed STATUS envelope inside swap:<id> (informational; used for liveness handshakes).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      state: {
        type: 'string',
        enum: ['init', 'terms', 'accepted', 'invoice', 'escrow', 'ln_paid', 'claimed', 'refunded', 'canceled'],
      },
      note: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['channel', 'trade_id', 'state'],
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
  tool(
    'intercomswap_ln_regtest_init',
    'Docker-only (regtest): bootstrap a funded Lightning channel between the two nodes in the compose stack (mine, fund, connect, open channel).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Optional override (must be within repo root).
        compose_file: { type: 'string', minLength: 1, maxLength: 400, pattern: '^[^\\s]+$' },
        from_service: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        to_service: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        channel_amount_sats: { type: 'integer', minimum: 10_000, maximum: 10_000_000_000, description: 'Channel capacity in sats (default 1,000,000).' },
        fund_btc: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          pattern: '^[0-9]+(?:\\.[0-9]{1,8})?$',
          description: 'BTC amount to send to each LN node wallet (default "1").',
        },
        mine_initial_blocks: { type: 'integer', minimum: 1, maximum: 500, description: 'Initial blocks to mine for spendable coins (default 101).' },
        mine_confirm_blocks: { type: 'integer', minimum: 1, maximum: 100, description: 'Blocks to mine for confirmations (default 6).' },
      },
      required: [],
    }
  ),
  tool(
    'intercomswap_ln_unlock',
    'LND-only: unlock the wallet (docker backend). Uses ln.wallet_password_file from prompt setup, or an inferred file under onchain/lnd/<network>/ (gitignored).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        password_file: {
          type: 'string',
          minLength: 1,
          maxLength: 400,
          pattern: '^[^\\s]+$',
          description:
            'Path to a file containing the LND wallet password. Must be under onchain/. If omitted, promptd uses ln.wallet_password_file then falls back to inferred names under onchain/lnd/<network>/ (e.g. maker.wallet-password.txt, taker.wallet-password.txt, wallet.pw).',
        },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Optional timeout (default 30000).' },
      },
      required: [],
    }
  ),
  tool('intercomswap_ln_info', 'Get Lightning node info (impl/backend configured locally).', emptyParams),
  tool('intercomswap_ln_newaddr', 'Get a new on-chain BTC address from the LN node wallet.', emptyParams),
  tool('intercomswap_ln_listpeers', 'List connected Lightning peers (used to suggest peer URIs).', emptyParams),
  tool('intercomswap_ln_listfunds', 'Get on-chain + channel balances.', emptyParams),
  tool('intercomswap_ln_listchannels', 'List Lightning channels with peer/state/balance details (for channel management).', emptyParams),
  tool('intercomswap_ln_closechannel', 'Close a Lightning channel (cooperative by default) to return liquidity to on-chain BTC.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel_id: {
        type: 'string',
        minLength: 3,
        maxLength: 200,
        description:
          'Channel identifier. LND: funding_txid:output_index (channel_point). CLN: channel_id/short_channel_id/peer_id.',
      },
      force: {
        type: 'boolean',
        description: 'Force-close (LND only). Default false (cooperative close).',
      },
      sat_per_vbyte: {
        type: 'integer',
        minimum: 1,
        maximum: 10_000,
        description: 'Optional close transaction feerate (sat/vB, LND only).',
      },
      block: {
        type: 'boolean',
        description: 'LND only: wait for close result synchronously.',
      },
    },
    required: ['channel_id'],
  }),
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
  tool('intercomswap_ln_fundchannel', 'Open a public Lightning channel to a peer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      node_id: {
        type: 'string',
        minLength: 66,
        maxLength: 66,
        pattern: '^[0-9a-fA-F]{66}$',
        description: 'Remote node pubkey (hex33). Optional if peer is provided or exactly one peer is already connected.',
      },
      peer: {
        type: 'string',
        minLength: 10,
        maxLength: 200,
        description: 'Optional nodeid@host:port. If node_id is omitted, the nodeid part is used.',
      },
      amount_sats: { type: 'integer', minimum: 1_000, maximum: 10_000_000_000 },
      push_sats: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000_000_000,
        description:
          'Optional initial push amount (sats) to remote peer for immediate inbound on your side. Must be < amount_sats. LND only.',
      },
      sat_per_vbyte: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Optional fee rate for the on-chain funding transaction.' },
    },
    required: ['amount_sats'],
  }),
  tool('intercomswap_ln_splice', 'Splice a Lightning channel in/out (CLN experimental splicing only). Use positive sats to add liquidity and negative sats to remove liquidity.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel_id: {
        type: 'string',
        minLength: 3,
        maxLength: 200,
        description: 'CLN channel identifier (channel_id / short_channel_id).',
      },
      relative_sats: {
        type: 'integer',
        minimum: -10_000_000_000,
        maximum: 10_000_000_000,
        description: 'Positive = splice in (add sats), negative = splice out (remove sats). Must be non-zero.',
      },
      sat_per_vbyte: {
        type: 'integer',
        minimum: 1,
        maximum: 10_000,
        description: 'Optional target feerate for splice funding tx.',
      },
      max_rounds: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Max splice_update negotiation rounds (default 24).',
      },
      sign_first: {
        type: 'boolean',
        description: 'Optional splice_signed sign_first flag (advanced).',
      },
    },
    required: ['channel_id', 'relative_sats'],
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
  tool(
    'intercomswap_ln_rebalance_selfpay',
    'Best-effort inbound rebalance: create an invoice on this node and pay it from this same node. Works best with LND using allow_self_payment; routing outcome depends on available channels/routes.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        amount_sats: { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000, description: 'Amount to loop through Lightning (sats).' },
        fee_limit_sat: { type: 'integer', minimum: 0, maximum: 10_000_000, description: 'Optional max routing fee for the self-payment.' },
        outgoing_chan_id: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          pattern: '^[0-9]+$',
          description: 'Optional LND-only outgoing chan_id pin (numeric).',
        },
        last_hop_pubkey: {
          type: 'string',
          minLength: 66,
          maxLength: 66,
          pattern: '^[0-9a-fA-F]{66}$',
          description: 'Optional LND-only last hop pubkey (hex33).',
        },
        expiry_sec: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 7, description: 'Optional invoice expiry.' },
      },
      required: ['amount_sats'],
    }
  ),
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
	    'Maker: init Solana escrow and post SOL_ESCROW_CREATED into swap:<id>. Fees are read from on-chain config/trade-config (not negotiated).',
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
	        trade_fee_collector: { ...base58Param, description: 'Fee receiver pubkey. trade_fee_bps is read from the trade-config PDA for this address.' },
	        cu_limit: solCuLimitParam,
	        cu_price: solCuPriceParam,
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
  tool(
    'intercomswap_swap_ln_route_precheck_from_terms_invoice',
    'Taker: decode invoice and run LN route/liquidity precheck from signed TERMS + LN_INVOICE before maker escrow is created.',
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
      },
      required: ['channel', 'terms_envelope', 'invoice_envelope'],
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
    },
    required: ['mint', 'to_owner', 'amount'],
  }),
  tool('intercomswap_sol_mint_create', 'Create a new SPL mint where the signer is mint+freeze authority (test/dev convenience).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      decimals: { type: 'integer', minimum: 0, maximum: 18 },
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
  tool('intercomswap_sol_escrow_init', 'Initialize an escrow locked to LN payment_hash. Fees are read from on-chain config/trade-config (not negotiated).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
      amount: atomicAmountParam,
      recipient: base58Param,
      refund: base58Param,
      refund_after_unix: unixSecParam,
      trade_fee_collector: { ...base58Param, description: 'Fee receiver pubkey. trade_fee_bps is read from the trade-config PDA for this address.' },
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
    },
    required: [
      'payment_hash_hex',
      'mint',
      'amount',
      'recipient',
      'refund',
      'refund_after_unix',
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
    },
    required: ['preimage_hex', 'mint'],
  }),
  tool('intercomswap_sol_escrow_refund', 'Refund escrow after timeout (refund signature required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
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
        cu_limit: solCuLimitParam,
        cu_price: solCuPriceParam,
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
        cu_limit: solCuLimitParam,
        cu_price: solCuPriceParam,
      },
      required: ['mint', 'to', 'amount'],
    }
  ),

  // Receipts / recovery (local-only, deterministic).
  tool('intercomswap_receipts_list', 'List local trade receipts (sqlite).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      db: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
      },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    },
    required: [],
  }),
  tool('intercomswap_receipts_show', 'Show a local receipt by trade_id.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      db: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
      },
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['trade_id'],
  }),
  tool('intercomswap_receipts_list_open_claims', 'List trades that look claimable (state=ln_paid and preimage present).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      db: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
      },
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
        db: {
          type: 'string',
          minLength: 1,
          maxLength: 400,
          description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
        },
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
      db: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
      },
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      payment_hash_hex: hex32Param,
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
    },
    required: [],
  }),
  tool('intercomswap_swaprecover_refund', 'Recover: refund an expired Solana escrow using local receipts + signer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      db: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Optional receipts db override (must be under onchain/receipts and end with .sqlite).',
      },
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      payment_hash_hex: hex32Param,
      cu_limit: solCuLimitParam,
      cu_price: solCuPriceParam,
    },
    required: [],
  }),
];
