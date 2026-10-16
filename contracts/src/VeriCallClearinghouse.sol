// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ──────────────────────────────────────────────────────────────────────────────
// Minimal IERC20 — only the surface the clearinghouse touches
// ──────────────────────────────────────────────────────────────────────────────
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// ──────────────────────────────────────────────────────────────────────────────
//  VeriCallClearinghouse
//
//  A permissioned, EIP-712–attested SLA clearinghouse on Arc EVM L1.
//  USDC (6 decimals, ERC-20 at 0x3600…0000 on Arc) is the sole settlement
//  asset.  Arc-specific constraints honoured:
//    • Blocklist-safe push via low-level call with fallback credit ledger
//    • maxFeePerGas floor of 20 gwei (enforced off-chain by node; no change needed
//      in contract logic)
//    • block.timestamp is non-decreasing (never requires strictly increasing)
//    • No PREVRANDAO, blobs, SELFDESTRUCT, or address(0) transfers
// ──────────────────────────────────────────────────────────────────────────────
contract VeriCallClearinghouse {

    // ──────────────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────────────

    string  public constant VERSION = "1.0.0";

    // EIP-712 type-hashes
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant SERVICE_REGISTRATION_TYPEHASH =
        keccak256("ServiceRegistration(address provider,string name,uint256 nonce,uint256 chainId)");

    bytes32 private constant SLA_ATTESTATION_TYPEHASH =
        keccak256("SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)");

    // secp256k1 curve order halved — malleability guard
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ──────────────────────────────────────────────────────────────────────
    // Types (public so tests can access)
    // ──────────────────────────────────────────────────────────────────────

    struct Split {
        address recipient;
        uint16  bps;
    }

    struct ServiceCovenant {
        uint256 id;
        address provider;
        address verifier;
        string  name;
        string  endpointUri;
        bytes32 schemaHash;
        uint256 callPriceUsdc;
        uint32  graceLatencyMs;
        uint32  hardTimeoutMs;
        uint16  maxRebateBps;
        uint16  slashPenaltyBps;
        uint256 providerBondUsdc;
        bool    active;
        Split[] splits;
    }

    enum OrderStatus {
        None,
        Funded,
        SettledPass,
        SettledDegraded,
        SettledBreached,
        ReclaimedExpired
    }

    struct CallOrder {
        uint256     id;
        uint256     serviceId;
        address     caller;
        uint256     escrowedUsdc;
        bytes32     requestHash;
        uint64      createdAt;
        uint64      expiryAt;
        OrderStatus status;
        uint32      measuredLatencyMs;
        bytes32     responseHash;
        bool        schemaValid;
        uint256     paidToProvider;
        uint256     paidToDependencies;
        uint256     refundedToCaller;
        uint256     bondSlashed;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    address public immutable owner;

    // EIP-712 domain separator (cached at construction; chainId is embedded)
    bytes32 private immutable _domainSeparator;

    // Per-provider nonce for service registration signatures
    mapping(address => uint256) public providerNonce;

    // Service registry
    uint256 private _serviceCount;
    mapping(uint256 => ServiceCovenant) private _services;
    mapping(uint256 => Split[])         private _splits;          // splits mirrored outside struct for iteration

    // Order registry
    uint256 private _orderCount;
    mapping(uint256 => CallOrder) private _orders;

    // Open-order counter per service (used for bond-withdrawal guard)
    mapping(uint256 => uint256) private _openOrderCount;

    // Blocklist-safe fallback credit ledger
    mapping(address => uint256) public claimable;

    // ──────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────

    event ServiceRegistered(uint256 indexed serviceId, address indexed provider, string name);
    event ServiceUpdated(uint256 indexed serviceId);
    event BondDeposited(uint256 indexed serviceId, uint256 amount);
    event BondWithdrawn(uint256 indexed serviceId, uint256 amount, address to);
    event OrderCreated(uint256 indexed orderId, uint256 indexed serviceId, address indexed caller);
    event OrderSettled(
        uint256 indexed orderId,
        OrderStatus status,
        uint32  latencyMs,
        bool    schemaValid,
        bytes32 responseHash,
        uint256 rebate,
        uint256 paidToProvider,
        uint256 paidToDependencies,
        uint256 bondSlashed
    );
    event OrderReclaimed(uint256 indexed orderId, address indexed caller);
    event TransferFallbackCredited(address indexed recipient, uint256 amount);
    event FallbackClaimed(address indexed recipient, uint256 amount);

    // ──────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────

    constructor(address usdc_, address owner_) {
        require(usdc_  != address(0), "VCC: zero usdc");
        require(owner_ != address(0), "VCC: zero owner");
        usdc  = IERC20(usdc_);
        owner = owner_;

        _domainSeparator = _buildDomainSeparator();
    }

    // ──────────────────────────────────────────────────────────────────────
    // EIP-712 helpers (written by hand, no OZ)
    // ──────────────────────────────────────────────────────────────────────

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes("VeriCall Clearinghouse")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    /// @dev Re-compute domain separator if chain forked (e.g. in tests with --chain-id override).
    function _getDomainSeparator() private view returns (bytes32) {
        // If we are on the same chain as at deploy-time (the common case), use the cached value.
        // In tests the anvil chain ID can differ, so recompute.
        return _buildDomainSeparator();
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _getDomainSeparator(), structHash));
    }

    /// @dev ecrecover with low-s malleability guard.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "VCC: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        require(v == 27 || v == 28,         "VCC: bad v");
        require(uint256(s) <= SECP256K1N_HALF, "VCC: high-s sig");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0),    "VCC: zero signer");
        return recovered;
    }

    function _recoverMem(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "VCC: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        require(v == 27 || v == 28,            "VCC: bad v");
        require(uint256(s) <= SECP256K1N_HALF, "VCC: high-s sig");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0),       "VCC: zero signer");
        return recovered;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Blocklist-safe USDC push
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Attempts a USDC transfer; on revert credits the fallback ledger
    ///      (Arc USDC blocklist or any other revert).  A restricted recipient
    ///      must never brick a settlement for other parties.
    function _safePush(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = address(usdc).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        if (!ok) {
            claimable[to] += amount;
            emit TransferFallbackCredited(to, amount);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Validation helpers
    // ──────────────────────────────────────────────────────────────────────

    function _validateSplits(
        address provider,
        address[] calldata recipients,
        uint16[]  calldata bps
    ) internal pure {
        require(recipients.length > 0,                  "VCC: empty splits");
        require(recipients.length == bps.length,        "VCC: split length mismatch");

        uint256 total;
        bool    providerFound;
        for (uint256 i; i < recipients.length; ++i) {
            require(recipients[i] != address(0), "VCC: zero recipient");
            total += bps[i];
            if (recipients[i] == provider) providerFound = true;
        }
        require(total == 10_000,   "VCC: splits != 10000");
        require(providerFound,     "VCC: provider not in splits");
    }

    // Bundled params to avoid stack-too-deep on wide function signatures
    struct _RegParams {
        address provider;
        address verifier;
        bytes32 schemaHash;
        uint256 callPriceUsdc;
        uint32  graceLatencyMs;
        uint32  hardTimeoutMs;
        uint16  maxRebateBps;
        uint16  slashPenaltyBps;
        uint256 initialBond;
    }

    function _validateCovenantParams(
        _RegParams memory p,
        string  calldata name_,
        string  calldata endpointUri_
    ) internal pure {
        require(p.provider        != address(0), "VCC: zero provider");
        require(bytes(name_).length      > 0,    "VCC: empty name");
        require(bytes(endpointUri_).length > 0,  "VCC: empty endpointUri");
        require(p.callPriceUsdc   > 0,           "VCC: zero callPrice");
        require(p.hardTimeoutMs   > 0,           "VCC: zero hardTimeout");
        require(p.graceLatencyMs  <= p.hardTimeoutMs, "VCC: grace > hard");
        require(p.maxRebateBps    <= 10_000,      "VCC: maxRebate > 10000");
        require(p.slashPenaltyBps <= 10_000,      "VCC: slashPenalty > 10000");
        require(p.initialBond     > 0,            "VCC: zero initialBond");
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal: store splits
    // ──────────────────────────────────────────────────────────────────────

    function _storeSplits(
        uint256 serviceId,
        address[] calldata recipients,
        uint16[]  calldata bps
    ) internal {
        Split[] storage arr = _splits[serviceId];
        // Clear any existing (shouldn't happen on register but defensive)
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) arr.pop();
        for (uint256 i; i < recipients.length; ++i) {
            arr.push(Split({ recipient: recipients[i], bps: bps[i] }));
        }
        // Mirror into covenant struct
        Split[] storage cs = _services[serviceId].splits;
        len = cs.length;
        for (uint256 i; i < len; ++i) cs.pop();
        for (uint256 i; i < recipients.length; ++i) {
            cs.push(Split({ recipient: recipients[i], bps: bps[i] }));
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal: populate service
    // ──────────────────────────────────────────────────────────────────────

    function _createService(
        _RegParams memory p,
        string  calldata name_,
        string  calldata endpointUri_,
        address[] calldata recipients_,
        uint16[]  calldata bps_
    ) internal returns (uint256 serviceId) {
        serviceId = ++_serviceCount;

        ServiceCovenant storage svc = _services[serviceId];
        svc.id              = serviceId;
        svc.provider        = p.provider;
        svc.verifier        = p.verifier;
        svc.name            = name_;
        svc.endpointUri     = endpointUri_;
        svc.schemaHash      = p.schemaHash;
        svc.callPriceUsdc   = p.callPriceUsdc;
        svc.graceLatencyMs  = p.graceLatencyMs;
        svc.hardTimeoutMs   = p.hardTimeoutMs;
        svc.maxRebateBps    = p.maxRebateBps;
        svc.slashPenaltyBps = p.slashPenaltyBps;
        svc.providerBondUsdc = 0;
        svc.active          = true;

        _storeSplits(serviceId, recipients_, bps_);

        // Pull initial bond from provider
        require(
            usdc.transferFrom(p.provider, address(this), p.initialBond),
            "VCC: bond transfer failed"
        );
        svc.providerBondUsdc = p.initialBond;

        emit ServiceRegistered(serviceId, p.provider, name_);
    }

    // ──────────────────────────────────────────────────────────────────────
    // registerService — EIP-712 signature path
    // ──────────────────────────────────────────────────────────────────────

    function registerService(
        address         provider_,
        address         verifier_,
        string  calldata name_,
        string  calldata endpointUri_,
        bytes32          schemaHash_,
        uint256          callPriceUsdc_,
        uint32           graceLatencyMs_,
        uint32           hardTimeoutMs_,
        uint16           maxRebateBps_,
        uint16           slashPenaltyBps_,
        uint256          initialBond_,
        address[] calldata recipients_,
        uint16[]  calldata bps_,
        uint256          providerNonce_,
        bytes    calldata providerSig_
    ) external returns (uint256 serviceId) {
        _RegParams memory p = _RegParams({
            provider:       provider_,
            verifier:       verifier_,
            schemaHash:     schemaHash_,
            callPriceUsdc:  callPriceUsdc_,
            graceLatencyMs: graceLatencyMs_,
            hardTimeoutMs:  hardTimeoutMs_,
            maxRebateBps:   maxRebateBps_,
            slashPenaltyBps: slashPenaltyBps_,
            initialBond:    initialBond_
        });
        _validateCovenantParams(p, name_, endpointUri_);
        _validateSplits(provider_, recipients_, bps_);

        // Verify EIP-712 ServiceRegistration
        require(providerNonce_ == providerNonce[provider_], "VCC: bad nonce");

        bytes32 structHash = keccak256(abi.encode(
            SERVICE_REGISTRATION_TYPEHASH,
            provider_,
            keccak256(bytes(name_)),
            providerNonce_,
            block.chainid
        ));
        bytes32 digest = _hashTypedData(structHash);
        address signer = _recover(digest, providerSig_);
        require(signer == provider_, "VCC: bad provider sig");

        providerNonce[provider_] += 1;

        serviceId = _createService(p, name_, endpointUri_, recipients_, bps_);
    }

    // ──────────────────────────────────────────────────────────────────────
    // registerServiceAuthorized — owner bypass
    // ──────────────────────────────────────────────────────────────────────

    function registerServiceAuthorized(
        address         provider_,
        address         verifier_,
        string  calldata name_,
        string  calldata endpointUri_,
        bytes32          schemaHash_,
        uint256          callPriceUsdc_,
        uint32           graceLatencyMs_,
        uint32           hardTimeoutMs_,
        uint16           maxRebateBps_,
        uint16           slashPenaltyBps_,
        uint256          initialBond_,
        address[] calldata recipients_,
        uint16[]  calldata bps_
    ) external returns (uint256 serviceId) {
        require(msg.sender == owner, "VCC: not owner");
        _RegParams memory p = _RegParams({
            provider:        provider_,
            verifier:        verifier_,
            schemaHash:      schemaHash_,
            callPriceUsdc:   callPriceUsdc_,
            graceLatencyMs:  graceLatencyMs_,
            hardTimeoutMs:   hardTimeoutMs_,
            maxRebateBps:    maxRebateBps_,
            slashPenaltyBps: slashPenaltyBps_,
            initialBond:     initialBond_
        });
        _validateCovenantParams(p, name_, endpointUri_);
        _validateSplits(provider_, recipients_, bps_);

        serviceId = _createService(p, name_, endpointUri_, recipients_, bps_);
    }

    // ──────────────────────────────────────────────────────────────────────
    // setVerifier
    // ──────────────────────────────────────────────────────────────────────

    function setVerifier(uint256 serviceId, address newVerifier) external {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0,                                          "VCC: no service");
        require(msg.sender == svc.provider || msg.sender == owner,   "VCC: not auth");
        svc.verifier = newVerifier;
        emit ServiceUpdated(serviceId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // setActive
    // ──────────────────────────────────────────────────────────────────────

    function setActive(uint256 serviceId, bool active_) external {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0,                                          "VCC: no service");
        require(msg.sender == svc.provider || msg.sender == owner,   "VCC: not auth");
        svc.active = active_;
        emit ServiceUpdated(serviceId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // depositBond
    // ──────────────────────────────────────────────────────────────────────

    function depositBond(uint256 serviceId, uint256 amount) external {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0, "VCC: no service");
        require(amount > 0,  "VCC: zero amount");
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "VCC: deposit failed"
        );
        svc.providerBondUsdc += amount;
        emit BondDeposited(serviceId, amount);
    }

    // ──────────────────────────────────────────────────────────────────────
    // withdrawBond
    // ──────────────────────────────────────────────────────────────────────

    function withdrawBond(uint256 serviceId, uint256 amount, address to) external {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0,               "VCC: no service");
        require(msg.sender == svc.provider, "VCC: not provider");
        require(!svc.active,               "VCC: service active");
        require(_openOrderCount[serviceId] == 0, "VCC: open orders exist");
        require(amount > 0,                "VCC: zero amount");
        require(amount <= svc.providerBondUsdc, "VCC: insufficient bond");
        require(to != address(0),          "VCC: zero to");

        svc.providerBondUsdc -= amount;
        _safePush(to, amount);
        emit BondWithdrawn(serviceId, amount, to);
    }

    // ──────────────────────────────────────────────────────────────────────
    // createOrder
    // ──────────────────────────────────────────────────────────────────────

    function createOrder(
        uint256 serviceId,
        bytes32 requestHash,
        uint64  ttlSeconds
    ) external returns (uint256 orderId) {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0,   "VCC: no service");
        require(svc.active,    "VCC: service inactive");

        // Bond coverage: providerBondUsdc must cover at least one more slash
        uint256 requiredCoverage = uint256(svc.slashPenaltyBps) * svc.callPriceUsdc / 10_000;
        require(
            svc.providerBondUsdc >= requiredCoverage,
            "VCC: bond underfunded"
        );

        uint256 price = svc.callPriceUsdc;
        require(
            usdc.transferFrom(msg.sender, address(this), price),
            "VCC: escrow transfer failed"
        );

        orderId = ++_orderCount;

        CallOrder storage o = _orders[orderId];
        o.id           = orderId;
        o.serviceId    = serviceId;
        o.caller       = msg.sender;
        o.escrowedUsdc = price;
        o.requestHash  = requestHash;
        o.createdAt    = uint64(block.timestamp);
        o.expiryAt     = uint64(block.timestamp) + ttlSeconds;
        o.status       = OrderStatus.Funded;

        _openOrderCount[serviceId] += 1;

        emit OrderCreated(orderId, serviceId, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Settlement math (shared with quoteSettlement)
    // ──────────────────────────────────────────────────────────────────────

    struct SettleCalc {
        OrderStatus status;
        uint256 rebate;
        uint256 bondSlash;
        uint256 net;
    }

    function _calcSettlement(
        uint256 escrowedUsdc,
        uint32  latencyMs,
        bool    schemaValid,
        uint32  graceLatencyMs,
        uint32  hardTimeoutMs,
        uint16  maxRebateBps,
        uint16  slashPenaltyBps,
        uint256 providerBondUsdc
    ) internal pure returns (SettleCalc memory c) {
        bool hardBreach = !schemaValid || latencyMs > hardTimeoutMs;

        if (hardBreach) {
            // Breach
            c.status    = OrderStatus.SettledBreached;
            c.rebate    = escrowedUsdc;
            uint256 maxSlash = uint256(slashPenaltyBps) * escrowedUsdc / 10_000;
            c.bondSlash = maxSlash < providerBondUsdc ? maxSlash : providerBondUsdc;
            c.net       = 0;
        } else if (
            latencyMs > graceLatencyMs &&
            maxRebateBps > 0 &&
            // A covenant with grace == hard has no interior to interpolate over,
            // so any overrun is already at the hard edge. Without this guard the
            // denominator below is zero and every such call reverts.
            hardTimeoutMs > graceLatencyMs
        ) {
            // Degraded: rebate = escrowed * maxRebateBps * (latencyMs - graceLatencyMs)
            //                          / (10000 * (hardTimeoutMs - graceLatencyMs))
            uint256 num = uint256(escrowedUsdc)
                * uint256(maxRebateBps)
                * uint256(latencyMs - graceLatencyMs);
            uint256 den = uint256(10_000) * uint256(hardTimeoutMs - graceLatencyMs);
            uint256 rebate = num / den;
            if (rebate > escrowedUsdc) rebate = escrowedUsdc;

            // Only count as degraded if rebate > 0 (per spec)
            if (rebate == 0) {
                c.status    = OrderStatus.SettledPass;
                c.rebate    = 0;
                c.bondSlash = 0;
                c.net       = escrowedUsdc;
            } else {
                c.status    = OrderStatus.SettledDegraded;
                c.rebate    = rebate;
                c.bondSlash = 0;
                c.net       = escrowedUsdc - rebate;
            }
        } else {
            // Pass
            c.status    = OrderStatus.SettledPass;
            c.rebate    = 0;
            c.bondSlash = 0;
            c.net       = escrowedUsdc;
        }
    }

    /// @dev Distribute `net` across splits.  The division remainder is given
    ///      to the provider's split share so all shares sum exactly to net.
    function _distributeSplits(
        uint256   serviceId,
        uint256   net,
        address   provider
    ) internal returns (uint256 paidToProvider, uint256 paidToDependencies) {
        Split[] storage splits = _splits[serviceId];
        uint256 len = splits.length;

        uint256 remainder = net;
        // First pass: compute floor amounts for each non-provider recipient
        // Provider's amount is whatever is left (absorbs remainder)
        for (uint256 i; i < len; ++i) {
            Split storage sp = splits[i];
            if (sp.recipient == provider) continue; // handled last
            uint256 share = net * uint256(sp.bps) / 10_000;
            remainder -= share;
            _safePush(sp.recipient, share);
            paidToDependencies += share;
        }
        // Provider receives the remainder (absorbs truncation dust)
        _safePush(provider, remainder);
        paidToProvider = remainder;
    }

    // ──────────────────────────────────────────────────────────────────────
    // settleOrder
    // ──────────────────────────────────────────────────────────────────────

    function settleOrder(
        uint256  orderId,
        uint32   latencyMs,
        bool     schemaValid,
        bytes32  responseHash,
        uint64   deadline,
        bytes calldata verifierSig
    ) external {
        CallOrder storage o = _orders[orderId];
        require(o.id != 0,                          "VCC: no order");
        require(o.status == OrderStatus.Funded,     "VCC: not funded");
        require(block.timestamp > o.createdAt,      "VCC: same block");
        require(block.timestamp <= o.expiryAt,      "VCC: order expired");
        require(block.timestamp <= uint256(deadline), "VCC: deadline passed");

        ServiceCovenant storage svc = _services[o.serviceId];

        // Verify SlaAttestation EIP-712 signature from verifier
        bytes32 structHash = keccak256(abi.encode(
            SLA_ATTESTATION_TYPEHASH,
            orderId,
            latencyMs,
            schemaValid,
            responseHash,
            address(svc.provider),   // "service" field = provider address
            deadline
        ));
        bytes32 digest = _hashTypedData(structHash);
        address signer = _recover(digest, verifierSig);
        require(signer == svc.verifier, "VCC: bad verifier sig");

        SettleCalc memory c = _calcSettlement(
            o.escrowedUsdc,
            latencyMs,
            schemaValid,
            svc.graceLatencyMs,
            svc.hardTimeoutMs,
            svc.maxRebateBps,
            svc.slashPenaltyBps,
            svc.providerBondUsdc
        );

        // Record
        o.status             = c.status;
        o.measuredLatencyMs  = latencyMs;
        o.responseHash       = responseHash;
        o.schemaValid        = schemaValid;
        o.refundedToCaller   = c.rebate;
        o.bondSlashed        = c.bondSlash;

        _openOrderCount[o.serviceId] -= 1;

        if (c.status == OrderStatus.SettledBreached) {
            // Refund escrow + bond slash to caller
            uint256 callerTotal = c.rebate + c.bondSlash; // rebate == escrowedUsdc in breach
            svc.providerBondUsdc -= c.bondSlash;
            _safePush(o.caller, callerTotal);
            o.refundedToCaller = callerTotal;
            o.paidToProvider   = 0;
            o.paidToDependencies = 0;
        } else {
            // Pass or degraded: split net, refund rebate
            (uint256 ptp, uint256 ptd) = _distributeSplits(o.serviceId, c.net, svc.provider);
            o.paidToProvider     = ptp;
            o.paidToDependencies = ptd;
            if (c.rebate > 0) {
                _safePush(o.caller, c.rebate);
            }
        }

        emit OrderSettled(
            orderId,
            c.status,
            latencyMs,
            schemaValid,
            responseHash,
            c.rebate,
            o.paidToProvider,
            o.paidToDependencies,
            c.bondSlash
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // reclaimExpiredOrder
    // ──────────────────────────────────────────────────────────────────────

    function reclaimExpiredOrder(uint256 orderId) external {
        CallOrder storage o = _orders[orderId];
        require(o.id != 0,                      "VCC: no order");
        require(o.status == OrderStatus.Funded, "VCC: not funded");
        require(block.timestamp > o.expiryAt,   "VCC: not expired");

        o.status           = OrderStatus.ReclaimedExpired;
        o.refundedToCaller = o.escrowedUsdc;

        _openOrderCount[o.serviceId] -= 1;

        _safePush(o.caller, o.escrowedUsdc);
        emit OrderReclaimed(orderId, o.caller);
    }

    // ──────────────────────────────────────────────────────────────────────
    // quoteSettlement (view)
    // ──────────────────────────────────────────────────────────────────────

    function quoteSettlement(
        uint256 serviceId,
        uint256 escrowedUsdc,
        uint32  latencyMs,
        bool    schemaValid
    ) external view returns (
        OrderStatus status,
        uint256 rebate,
        uint256 bondSlash,
        uint256 net,
        uint256[] memory splitAmounts
    ) {
        ServiceCovenant storage svc = _services[serviceId];
        require(svc.id != 0, "VCC: no service");

        SettleCalc memory c = _calcSettlement(
            escrowedUsdc,
            latencyMs,
            schemaValid,
            svc.graceLatencyMs,
            svc.hardTimeoutMs,
            svc.maxRebateBps,
            svc.slashPenaltyBps,
            svc.providerBondUsdc
        );

        status    = c.status;
        rebate    = c.rebate;
        bondSlash = c.bondSlash;
        net       = c.net;

        Split[] storage splits = _splits[serviceId];
        uint256 len = splits.length;
        splitAmounts = new uint256[](len);

        if (c.status != OrderStatus.SettledBreached) {
            // Mirror the exact distribution logic from _distributeSplits
            uint256 remainder = c.net;
            // Identify provider index
            uint256 providerIdx = type(uint256).max;
            for (uint256 i; i < len; ++i) {
                if (splits[i].recipient == svc.provider) {
                    providerIdx = i;
                    break;
                }
            }
            for (uint256 i; i < len; ++i) {
                if (i == providerIdx) continue;
                uint256 share = c.net * uint256(splits[i].bps) / 10_000;
                splitAmounts[i] = share;
                remainder -= share;
            }
            if (providerIdx != type(uint256).max) {
                splitAmounts[providerIdx] = remainder;
            }
        }
        // breach: all splitAmounts remain 0 (caller gets escrow + bondSlash)
    }

    // ──────────────────────────────────────────────────────────────────────
    // claimFallback
    // ──────────────────────────────────────────────────────────────────────

    function claimFallback() external {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "VCC: nothing to claim");
        claimable[msg.sender] = 0;
        require(
            usdc.transfer(msg.sender, amount),
            "VCC: claim transfer failed"
        );
        emit FallbackClaimed(msg.sender, amount);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────

    function version() external pure returns (string memory) {
        return VERSION;
    }

    function getServiceCount() external view returns (uint256) {
        return _serviceCount;
    }

    function getService(uint256 serviceId) external view returns (ServiceCovenant memory) {
        return _services[serviceId];
    }

    function getSplits(uint256 serviceId) external view returns (Split[] memory) {
        return _splits[serviceId];
    }

    function getOrderCount() external view returns (uint256) {
        return _orderCount;
    }

    function getOrder(uint256 orderId) external view returns (CallOrder memory) {
        return _orders[orderId];
    }

    function totalEscrowed() external view returns (uint256 total) {
        for (uint256 i = 1; i <= _orderCount; ++i) {
            CallOrder storage o = _orders[i];
            if (o.status == OrderStatus.Funded) {
                total += o.escrowedUsdc;
            }
        }
    }

    function totalBond() external view returns (uint256 total) {
        for (uint256 i = 1; i <= _serviceCount; ++i) {
            total += _services[i].providerBondUsdc;
        }
    }
}
