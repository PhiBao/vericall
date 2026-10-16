/**
 * The contract surface this tooling drives, written out explicitly.
 *
 * `contracts/abi-lock.json` holds the compiled selectors and
 * `verifier/src/abi.rs` asserts both the Rust bindings and these signatures
 * against it, so a drift between any two of the three surfaces fails a test
 * rather than a settlement.
 */

export const CLEARINGHOUSE_ABI = [
  // ---- write ---------------------------------------------------------------
  {
    type: "function",
    name: "registerServiceAuthorized",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider_", type: "address" },
      { name: "verifier_", type: "address" },
      { name: "name_", type: "string" },
      { name: "endpointUri_", type: "string" },
      { name: "schemaHash_", type: "bytes32" },
      { name: "callPriceUsdc_", type: "uint256" },
      { name: "graceLatencyMs_", type: "uint32" },
      { name: "hardTimeoutMs_", type: "uint32" },
      { name: "maxRebateBps_", type: "uint16" },
      { name: "slashPenaltyBps_", type: "uint16" },
      { name: "initialBond_", type: "uint256" },
      { name: "recipients_", type: "address[]" },
      { name: "bps_", type: "uint16[]" },
    ],
    outputs: [{ name: "serviceId", type: "uint256" }],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "requestHash", type: "bytes32" },
      { name: "ttlSeconds", type: "uint64" },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
  {
    type: "function",
    name: "settleOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "latencyMs", type: "uint32" },
      { name: "schemaValid", type: "bool" },
      { name: "responseHash", type: "bytes32" },
      { name: "deadline", type: "uint64" },
      { name: "verifierSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaimExpiredOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimFallback",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "depositBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setActive",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "active_", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setVerifier",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "newVerifier", type: "address" },
    ],
    outputs: [],
  },

  // ---- read ----------------------------------------------------------------
  {
    type: "function",
    name: "quoteSettlement",
    stateMutability: "view",
    inputs: [
      { name: "serviceId", type: "uint256" },
      { name: "escrowedUsdc", type: "uint256" },
      { name: "latencyMs", type: "uint32" },
      { name: "schemaValid", type: "bool" },
    ],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "rebate", type: "uint256" },
      { name: "bondSlash", type: "uint256" },
      { name: "net", type: "uint256" },
      { name: "splitAmounts", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "getService",
    stateMutability: "view",
    inputs: [{ name: "serviceId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "provider", type: "address" },
          { name: "verifier", type: "address" },
          { name: "name", type: "string" },
          { name: "endpointUri", type: "string" },
          { name: "schemaHash", type: "bytes32" },
          { name: "callPriceUsdc", type: "uint256" },
          { name: "graceLatencyMs", type: "uint32" },
          { name: "hardTimeoutMs", type: "uint32" },
          { name: "maxRebateBps", type: "uint16" },
          { name: "slashPenaltyBps", type: "uint16" },
          { name: "providerBondUsdc", type: "uint256" },
          { name: "active", type: "bool" },
          {
            name: "splits",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "bps", type: "uint16" },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getSplits",
    stateMutability: "view",
    inputs: [{ name: "serviceId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "bps", type: "uint16" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "serviceId", type: "uint256" },
          { name: "caller", type: "address" },
          { name: "escrowedUsdc", type: "uint256" },
          { name: "requestHash", type: "bytes32" },
          { name: "createdAt", type: "uint64" },
          { name: "expiryAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "measuredLatencyMs", type: "uint32" },
          { name: "responseHash", type: "bytes32" },
          { name: "schemaValid", type: "bool" },
          { name: "paidToProvider", type: "uint256" },
          { name: "paidToDependencies", type: "uint256" },
          { name: "refundedToCaller", type: "uint256" },
          { name: "bondSlashed", type: "uint256" },
        ],
      },
    ],
  },
  { type: "function", name: "getServiceCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOrderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalEscrowed", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalBond", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "providerNonce", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "version", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] },

  // ---- events (used by the verifier to reconstruct the ledger) --------------
  {
    type: "event",
    name: "ServiceRegistered",
    inputs: [
      { name: "serviceId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderSettled",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "status", type: "uint8", indexed: false },
      { name: "latencyMs", type: "uint32", indexed: false },
      { name: "schemaValid", type: "bool", indexed: false },
      { name: "responseHash", type: "bytes32", indexed: false },
      { name: "rebate", type: "uint256", indexed: false },
      { name: "paidToProvider", type: "uint256", indexed: false },
      { name: "paidToDependencies", type: "uint256", indexed: false },
      { name: "bondSlashed", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Minimal USDC surface: the ERC-20 interface predeployed on Arc (6 decimals). */
export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** The same ERC-20 interface is predeployed on Arc mainnet and testnet. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const USDC_DECIMALS = 6;

/** Arc mempool floor: a lower tip is dropped silently, not rejected. */
export const MIN_MAX_FEE_PER_GAS_WEI = 20_000_000_000n;

export const STATUS = {
  NONE: 0,
  FUNDED: 1,
  SETTLED_PASS: 2,
  SETTLED_DEGRADED: 3,
  SETTLED_BREACHED: 4,
  RECLAIMED_EXPIRED: 5,
} as const;

export const STATUS_NAME: Record<number, string> = {
  0: "none",
  1: "funded",
  2: "settled_pass",
  3: "settled_degraded",
  4: "settled_breached",
  5: "reclaimed_expired",
};
