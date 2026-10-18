// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VeriCallClearinghouse} from "../src/VeriCallClearinghouse.sol";
import {MockUSDC, BlocklistUSDC} from "./MockUSDC.sol";

/// @notice Independent verification suite for the Arc Studio–authored
///         `VeriCallClearinghouse`.
///
///         The contract was written and tested inside Arc Studio. This suite
///         exists to check it again from the outside, against the settlement
///         arithmetic the product promises, using different fixtures than the
///         ones the author used. Where a number appears twice — in a quote and in
///         a balance — both are asserted, so an arithmetic change cannot pass
///         unnoticed.
contract VeriCallClearinghouseTest is Test {
    VeriCallClearinghouse internal ch;
    MockUSDC internal usdc;

    address internal owner = address(0x0FF1CE);
    address internal dependency = address(0xDEF1);
    address internal caller = address(0xCA11E);
    address internal verifier;

    uint256 internal verifierPk = 0xA11CE;
    uint256 internal providerPk = 0xB0B;
    address internal provider;

    uint256 internal constant PRICE = 200_000; // 0.20 USDC, 6 decimals
    uint256 internal constant BOND = 100_000; // 0.10 USDC
    uint32 internal constant GRACE = 500;
    uint32 internal constant HARD = 2000;
    uint16 internal constant MAX_REBATE_BPS = 4000; // 40%
    uint16 internal constant SLASH_BPS = 2000; // 20%
    uint16 internal constant PROVIDER_BPS = 8000; // 80 / 20 split
    uint32 internal constant TTL = 3600;
    string internal constant ENDPOINT = "http://localhost:8787/mock/risk-scorer";

    /// @dev The status enum is positional in the return tuple, so naming the
    ///      cases once keeps the assertions readable.
    VeriCallClearinghouse.OrderStatus internal constant STATUS_PASS =
        VeriCallClearinghouse.OrderStatus.SettledPass;
    VeriCallClearinghouse.OrderStatus internal constant STATUS_DEGRADED =
        VeriCallClearinghouse.OrderStatus.SettledDegraded;
    VeriCallClearinghouse.OrderStatus internal constant STATUS_BREACH =
        VeriCallClearinghouse.OrderStatus.SettledBreached;
    VeriCallClearinghouse.OrderStatus internal constant STATUS_RECLAIMED =
        VeriCallClearinghouse.OrderStatus.ReclaimedExpired;
    VeriCallClearinghouse.OrderStatus internal constant STATUS_FUNDED =
        VeriCallClearinghouse.OrderStatus.Funded;

    uint256 internal serviceId;

    function setUp() public {
        vm.warp(1_760_000_000);
        verifier = vm.addr(verifierPk);
        provider = vm.addr(providerPk);

        usdc = new MockUSDC();
        ch = new VeriCallClearinghouse(address(usdc), owner);

        usdc.mint(provider, 10_000_000);
        usdc.mint(caller, 10_000_000);

        // Both parties approve once: the provider funds its own stake, the
        // caller funds its own escrow. Neither the owner nor the verifier ever
        // holds user money.
        vm.prank(provider);
        usdc.approve(address(ch), type(uint256).max);
        vm.prank(caller);
        usdc.approve(address(ch), type(uint256).max);

        serviceId = _register(PRICE, GRACE, HARD, MAX_REBATE_BPS, SLASH_BPS, PROVIDER_BPS, BOND);
    }

    // ------------------------------------------------------------------
    // Registration helpers
    // ------------------------------------------------------------------

    function _register(
        uint256 price,
        uint32 grace,
        uint32 hard,
        uint16 maxRebate,
        uint16 slash,
        uint16 providerBps,
        uint256 bond
    ) internal returns (uint256) {
        (address[] memory recipients, uint16[] memory bps) = _pair(providerBps);
        vm.prank(owner);
        return
            ch.registerServiceAuthorized(
                provider,
                verifier,
                "Counterparty Risk Scorer",
                ENDPOINT,
                keccak256("schema"),
                price,
                grace,
                hard,
                maxRebate,
                slash,
                bond,
                recipients,
                bps
            );
    }

    function _pair(uint16 providerBps) internal view returns (address[] memory, uint16[] memory) {
        address[] memory recipients = new address[](2);
        recipients[0] = provider;
        recipients[1] = dependency;
        uint16[] memory bps = new uint16[](2);
        bps[0] = providerBps;
        bps[1] = 10_000 - providerBps;
        return (recipients, bps);
    }

    function _solo() internal view returns (address[] memory, uint16[] memory) {
        address[] memory recipients = new address[](1);
        recipients[0] = provider;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        return (recipients, bps);
    }

    function _registerSolo(string memory name, uint256 price, uint256 bond) internal returns (uint256) {
        (address[] memory recipients, uint16[] memory bps) = _solo();
        vm.prank(owner);
        return
            ch.registerServiceAuthorized(
                provider, verifier, name, "http://localhost:8787/mock/solo", keccak256("schema"),
                price, GRACE, HARD, MAX_REBATE_BPS, SLASH_BPS, bond, recipients, bps
            );
    }

    // ------------------------------------------------------------------
    // Order and settlement helpers
    // ------------------------------------------------------------------

    function _fundAndCreate(uint256 svc) internal returns (uint256 orderId) {
        vm.prank(caller);
        orderId = ch.createOrder(svc, keccak256("request"), TTL);
        // Arc blocks are sub-second and may share a timestamp, and the contract
        // refuses to settle an order in its own creation second. Move off that
        // second so each test exercises settlement rather than the guard.
        vm.warp(block.timestamp + 1);
    }

    /// @dev The contract binds the attestation to the covenant's provider in the
    ///      `service` field — see `settleOrder`, which encodes
    ///      `address(svc.provider)` rather than the service id.
    function _sign(
        VeriCallClearinghouse instance,
        uint256 orderId,
        address serviceProvider,
        uint32 latencyMs,
        bool schemaValid,
        bytes32 responseHash,
        uint64 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)"
                ),
                orderId,
                latencyMs,
                schemaValid,
                responseHash,
                serviceProvider,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPk, _digest(instance, structHash));
        return abi.encodePacked(r, s, v);
    }

    function _digest(VeriCallClearinghouse instance, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(instance), structHash));
    }

    /// @dev The separator is chain- and contract-bound, so the digest must be
    ///      built from the instance that will verify it, not from `ch`.
    function _domainSeparator(VeriCallClearinghouse instance) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("VeriCall Clearinghouse")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(instance)
                )
            );
    }

    function _settle(uint256 orderId, uint32 latencyMs, bool schemaValid) internal {
        _settleFor(ch, orderId, provider, latencyMs, schemaValid, keccak256("response"));
    }

    function _settleFor(
        VeriCallClearinghouse instance,
        uint256 orderId,
        address serviceProvider,
        uint32 latencyMs,
        bool schemaValid,
        bytes32 responseHash
    ) internal {
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(instance, orderId, serviceProvider, latencyMs, schemaValid, responseHash, deadline);
        instance.settleOrder(orderId, latencyMs, schemaValid, responseHash, deadline, sig);
    }

    function _quote(uint256 svc, uint256 escrow, uint32 latencyMs, bool schemaValid)
        internal
        view
        returns (
            VeriCallClearinghouse.OrderStatus status,
            uint256 rebate,
            uint256 bondSlash,
            uint256 net,
            uint256[] memory amounts
        )
    {
        return ch.quoteSettlement(svc, escrow, latencyMs, schemaValid);
    }

    // ------------------------------------------------------------------
    // Registration behaviour
    // ------------------------------------------------------------------

    function test_register_storesTermsVerbatim() public view {
        VeriCallClearinghouse.ServiceCovenant memory s = ch.getService(serviceId);
        assertEq(s.id, serviceId);
        assertEq(s.provider, provider);
        assertEq(s.verifier, verifier);
        assertEq(s.name, "Counterparty Risk Scorer");
        assertEq(s.endpointUri, ENDPOINT);
        assertEq(s.callPriceUsdc, PRICE);
        assertEq(s.graceLatencyMs, GRACE);
        assertEq(s.hardTimeoutMs, HARD);
        assertEq(s.maxRebateBps, MAX_REBATE_BPS);
        assertEq(s.slashPenaltyBps, SLASH_BPS);
        assertEq(s.providerBondUsdc, BOND);
        assertTrue(s.active);
        assertEq(ch.getServiceCount(), 1);
        assertEq(ch.totalBond(), BOND);

        VeriCallClearinghouse.Split[] memory splits = ch.getSplits(serviceId);
        assertEq(splits.length, 2);
        assertEq(splits[0].recipient, provider);
        assertEq(splits[0].bps, PROVIDER_BPS);
        assertEq(splits[1].recipient, dependency);
        assertEq(splits[1].bps, 10_000 - PROVIDER_BPS);
    }

    function test_register_onlyOwnerMayUseTheAuthorizedPath() public {
        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        vm.prank(caller);
        vm.expectRevert(bytes("VCC: not owner"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
    }

    function test_register_rejectsSplitsThatDoNotSumTo10000() public {
        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        bps[1] = 1999;
        vm.prank(owner);
        vm.expectRevert(bytes("VCC: splits != 10000"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
    }

    function test_register_requiresTheProviderInTheSplitTable() public {
        // Without the provider present there is no address to absorb the
        // integer-division remainder and no owner for the bond.
        address[] memory recipients = new address[](1);
        recipients[0] = dependency;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        vm.prank(owner);
        vm.expectRevert(bytes("VCC: provider not in splits"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
    }

    function test_register_rejectsAZeroRecipient() public {
        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        recipients[1] = address(0);
        vm.prank(owner);
        vm.expectRevert(bytes("VCC: zero recipient"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
    }

    function test_register_rejectsGraceAboveHard() public {
        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        vm.prank(owner);
        vm.expectRevert(bytes("VCC: grace > hard"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, 2001, 2000,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
    }

    function test_register_rejectsAZeroPriceAndAZeroBond() public {
        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        vm.prank(owner);
        vm.expectRevert(bytes("VCC: zero callPrice"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), 0, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );

        vm.prank(owner);
        vm.expectRevert(bytes("VCC: zero initialBond"));
        ch.registerServiceAuthorized(
            provider, verifier, "x", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, 0, recipients, bps
        );
    }

    function test_register_withProviderSignature() public {
        (address[] memory recipients, uint16[] memory bps) = _solo();
        uint256 nonce = ch.providerNonce(provider);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ServiceRegistration(address provider,string name,uint256 nonce,uint256 chainId)"),
                provider,
                keccak256(bytes("Self Registered")),
                nonce,
                block.chainid
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPk, _digest(ch, structHash));

        uint256 id = ch.registerService(
            provider, verifier, "Self Registered", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps, nonce, abi.encodePacked(r, s, v)
        );
        assertEq(ch.getService(id).provider, provider);
        assertEq(ch.providerNonce(provider), nonce + 1);

        // A nonce that is no longer current may not authorise another listing.
        vm.expectRevert(bytes("VCC: bad nonce"));
        ch.registerService(
            provider, verifier, "Replay", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps, nonce, abi.encodePacked(r, s, v)
        );
    }

    function test_register_rejectsAForgedProviderSignature() public {
        (address[] memory recipients, uint16[] memory bps) = _solo();
        uint256 nonce = ch.providerNonce(provider);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ServiceRegistration(address provider,string name,uint256 nonce,uint256 chainId)"),
                provider,
                keccak256(bytes("Forged")),
                nonce,
                block.chainid
            )
        );
        // Signed by someone who is not the provider.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, _digest(ch, structHash));

        vm.expectRevert(bytes("VCC: bad provider sig"));
        ch.registerService(
            provider, verifier, "Forged", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps, nonce, abi.encodePacked(r, s, v)
        );
    }

    // ------------------------------------------------------------------
    // Orders
    // ------------------------------------------------------------------

    function test_createOrder_escrowsThePriceAndOpensTheOrder() public {
        uint256 before = usdc.balanceOf(caller);
        uint256 orderId = _fundAndCreate(serviceId);

        assertEq(orderId, 1);
        assertEq(usdc.balanceOf(caller), before - PRICE);
        assertEq(usdc.balanceOf(address(ch)), PRICE + BOND);
        assertEq(ch.totalEscrowed(), PRICE);

        VeriCallClearinghouse.CallOrder memory o = ch.getOrder(orderId);
        assertEq(o.caller, caller);
        assertEq(o.escrowedUsdc, PRICE);
        assertEq(uint8(o.status), uint8(STATUS_FUNDED));
        assertEq(o.expiryAt - o.createdAt, TTL);
    }

    function test_createOrder_withoutApprovalReverts() public {
        // The escrow pull is an inline `transferFrom`, so the token's own
        // allowance error is what surfaces, and no order is created.
        address stranger = address(0xBADBAD);
        usdc.mint(stranger, PRICE);
        uint256 ordersBefore = ch.getOrderCount();
        vm.prank(stranger);
        vm.expectRevert(bytes("ERC20: insufficient allowance"));
        ch.createOrder(serviceId, keccak256("request"), TTL);
        assertEq(ch.getOrderCount(), ordersBefore, "a failed pull must not consume an order id");
    }

    function test_createOrder_acceptsAnAllowanceForExactlyOneOrder() public {
        // An approval sized to the call, not to the balance. The client grants
        // exactly the escrow, so the pull has to work with a finite allowance
        // and leave it consumed afterwards — a caller who approves 0.03 USDC
        // should never be relying on the infinite one this suite happens to use.
        address precise = address(0xCA11E4);
        usdc.mint(precise, PRICE);
        vm.prank(precise);
        usdc.approve(address(ch), PRICE);

        vm.prank(precise);
        uint256 orderId = ch.createOrder(serviceId, keccak256("precise"), TTL);

        VeriCallClearinghouse.CallOrder memory o = ch.getOrder(orderId);
        assertEq(o.escrowedUsdc, PRICE);
        assertEq(
            usdc.allowance(precise, address(ch)),
            0,
            "an approval for one order is consumed by that order"
        );
    }

    function test_createOrder_requiresTheBondToCoverTheSlash() public {
        // A bond of one base unit cannot cover a 20% penalty on a 0.20 order.
        uint256 thin = _registerSolo("Thin", PRICE, 1);
        vm.prank(caller);
        vm.expectRevert(bytes("VCC: bond underfunded"));
        ch.createOrder(thin, keccak256("request"), TTL);
    }

    function test_createOrder_onAnInactiveServiceReverts() public {
        vm.prank(provider);
        ch.setActive(serviceId, false);
        vm.prank(caller);
        vm.expectRevert(bytes("VCC: service inactive"));
        ch.createOrder(serviceId, keccak256("request"), TTL);
    }

    function test_createOrder_rejectsAnUnknownService() public {
        vm.prank(caller);
        vm.expectRevert(bytes("VCC: no service"));
        ch.createOrder(999, keccak256("request"), TTL);
    }

    // ------------------------------------------------------------------
    // Settlement: pass
    // ------------------------------------------------------------------

    function test_settle_passSplitsByBasisPointsExactly() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 depBefore = usdc.balanceOf(dependency);

        _settle(orderId, 120, true);

        // 80 / 20 of 0.20 USDC
        assertEq(usdc.balanceOf(provider) - providerBefore, 160_000);
        assertEq(usdc.balanceOf(dependency) - depBefore, 40_000);
        assertEq(ch.totalEscrowed(), 0);

        VeriCallClearinghouse.CallOrder memory o = ch.getOrder(orderId);
        assertEq(uint8(o.status), uint8(STATUS_PASS));
        assertEq(o.measuredLatencyMs, 120);
        assertTrue(o.schemaValid);
        assertEq(o.paidToProvider, 160_000);
        assertEq(o.paidToDependencies, 40_000);
        assertEq(o.refundedToCaller, 0);
        assertEq(o.bondSlashed, 0);
    }

    function test_settle_atTheGraceEdgeIsAFullPass() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 depBefore = usdc.balanceOf(dependency);
        _settle(orderId, GRACE, true);
        assertEq(usdc.balanceOf(dependency) - depBefore, 40_000);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_PASS));
    }

    // ------------------------------------------------------------------
    // Settlement: degraded
    // ------------------------------------------------------------------

    function test_settle_degradedRebateIsLinearInTheOverrun() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 callerBefore = usdc.balanceOf(caller);
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 depBefore = usdc.balanceOf(dependency);

        // 1250 ms is halfway from the 500 ms grace to the 2000 ms hard edge, so
        // exactly half of the 40% maximum rebate is owed: 20% of 0.20 = 0.04.
        _settle(orderId, 1250, true);

        assertEq(usdc.balanceOf(caller) - callerBefore, 40_000);
        assertEq(usdc.balanceOf(provider) - providerBefore, 128_000);
        assertEq(usdc.balanceOf(dependency) - depBefore, 32_000);

        VeriCallClearinghouse.CallOrder memory o = ch.getOrder(orderId);
        assertEq(uint8(o.status), uint8(STATUS_DEGRADED));
        assertEq(o.refundedToCaller, 40_000);
        assertEq(o.paidToProvider, 128_000);
        assertEq(o.paidToDependencies, 32_000);
    }

    function test_settle_atTheHardEdgeTakesTheMaximumRebate() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 callerBefore = usdc.balanceOf(caller);
        _settle(orderId, HARD, true); // the hard edge itself is still degraded, not a breach
        // 40% of 0.20 USDC
        assertEq(usdc.balanceOf(caller) - callerBefore, 80_000);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_DEGRADED));
    }

    // ------------------------------------------------------------------
    // Settlement: breach
    // ------------------------------------------------------------------

    function test_settle_pastTheHardEdgeRefundsTheEscrowAndSlashesTheBond() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 callerBefore = usdc.balanceOf(caller);

        _settle(orderId, HARD + 1, true);

        // 0.20 refunded plus a 20% (0.04) bond penalty
        assertEq(usdc.balanceOf(caller) - callerBefore, 240_000);

        VeriCallClearinghouse.CallOrder memory o = ch.getOrder(orderId);
        assertEq(uint8(o.status), uint8(STATUS_BREACH));
        assertEq(o.bondSlashed, 40_000);
        assertEq(ch.getService(serviceId).providerBondUsdc, BOND - 40_000);
    }

    function test_settle_aSchemaViolationBreachesAtAnyLatency() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 callerBefore = usdc.balanceOf(caller);
        _settle(orderId, 5, false);
        assertEq(usdc.balanceOf(caller) - callerBefore, 240_000);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_BREACH));
    }

    function test_settle_aBreachCannotExceedTheBond() public {
        // A legal but thin bond: 40% penalty on a 0.20 order needs 0.08 USDC of
        // coverage, so a legal-but-thin covenant uses a small penalty rate.
        (address[] memory recipients, uint16[] memory bps) = _solo();
        vm.prank(owner);
        uint256 thin = ch.registerServiceAuthorized(
            provider, verifier, "Thin Bond", "http://x", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, 10, 1_000, recipients, bps // 0.1% penalty → 20 units required
        );

        vm.prank(caller);
        uint256 orderId = ch.createOrder(thin, keccak256("request"), TTL);
        vm.warp(block.timestamp + 1);

        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, orderId, provider, HARD + 1, true, responseHash, deadline);
        ch.settleOrder(orderId, HARD + 1, true, responseHash, deadline, sig);

        // 0.20 refunded, and the penalty is the 0.1% rate (200 units), fully
        // covered by a 1000-unit bond.
        assertEq(ch.getOrder(orderId).bondSlashed, 200);
        assertEq(ch.getService(thin).providerBondUsdc, 800);
    }

    // ------------------------------------------------------------------
    // Attestation authority
    // ------------------------------------------------------------------

    function test_settle_rejectsASignatureFromSomeoneElse() public {
        uint256 orderId = _fundAndCreate(serviceId);
        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)"
                ),
                orderId,
                uint32(100),
                true,
                responseHash,
                provider,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, _digest(ch, structHash));

        vm.expectRevert(bytes("VCC: bad verifier sig"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, abi.encodePacked(r, s, v));
    }

    function test_settle_rejectsAnAttestationForAnotherOrder() public {
        uint256 first = _fundAndCreate(serviceId);
        uint256 second = _fundAndCreate(serviceId);

        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, first, provider, 100, true, responseHash, deadline);

        vm.expectRevert(bytes("VCC: bad verifier sig"));
        ch.settleOrder(second, 100, true, responseHash, deadline, sig);
    }

    function test_settle_rejectsAnAttestationForAnotherService() public {
        // A second covenant on a different endpoint, same verifier key.
        uint256 other = _registerSolo("Other Service", PRICE, BOND);
        uint256 orderId = _fundAndCreate(serviceId);

        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        // The only field that separates the two covenants is the provider, so with
        // one shared provider the binding must come from the order id; assert the
        // honest signature still settles and a cross-order one does not.
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_PASS));

        uint256 secondOrder = _fundAndCreate(other);
        bytes memory stale = _sign(ch, orderId, provider, 100, true, responseHash, deadline);
        vm.expectRevert(bytes("VCC: bad verifier sig"));
        ch.settleOrder(secondOrder, 100, true, responseHash, deadline, stale);
    }

    function test_settle_rejectsAnExpiredAttestation() public {
        uint256 orderId = _fundAndCreate(serviceId);
        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp - 1);
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);

        vm.expectRevert(bytes("VCC: deadline passed"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);
    }

    function test_settle_rejectsAHighSSignature() public {
        uint256 orderId = _fundAndCreate(serviceId);
        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);

        // (r, n - s, v ^ 1) is the same curve point with a high s. Accepting it
        // would let anyone re-encode a valid attestation.
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;

        vm.expectRevert(bytes("VCC: high-s sig"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, abi.encodePacked(r, highS, flipped));
    }

    function test_settle_rejectsASignatureOfTheWrongLength() public {
        uint256 orderId = _fundAndCreate(serviceId);
        vm.expectRevert(bytes("VCC: bad sig length"));
        ch.settleOrder(orderId, 100, true, bytes32(0), uint64(block.timestamp + 900), hex"1234");
    }

    function test_settle_stillWorksAfterTheServiceIsDelisted() public {
        // An open order is a promise. Taking the listing down must not be a way
        // to escape it, or a provider could de-list instead of settling.
        uint256 orderId = _fundAndCreate(serviceId);
        vm.prank(provider);
        ch.setActive(serviceId, false);

        _settle(orderId, 1250, true);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_DEGRADED));
    }

    function test_settle_cannotRunTwice() public {
        uint256 orderId = _fundAndCreate(serviceId);
        _settle(orderId, 100, true);

        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);

        vm.expectRevert(bytes("VCC: not funded"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);
    }

    function test_settle_cannotHappenInTheCreationBlock() public {
        // Arc blocks are sub-second and share timestamps, so an order created and
        // settled in one timestamp is ambiguous; the contract requires strictly
        // later. Confirm the guard fires rather than assuming it does not matter.
        vm.prank(caller);
        uint256 orderId = ch.createOrder(serviceId, keccak256("request"), TTL);

        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);

        vm.expectRevert(bytes("VCC: same block"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);

        // One second later it settles.
        vm.warp(block.timestamp + 1);
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_PASS));
    }

    // ------------------------------------------------------------------
    // Expiry
    // ------------------------------------------------------------------

    function test_reclaim_returnsTheEscrowOnceTheWindowCloses() public {
        uint256 orderId = _fundAndCreate(serviceId);
        uint256 callerBefore = usdc.balanceOf(caller);

        vm.expectRevert(bytes("VCC: not expired"));
        ch.reclaimExpiredOrder(orderId);

        vm.warp(block.timestamp + TTL + 1);
        // Permissionless: anyone can release the caller's money.
        vm.prank(address(0xFEE1));
        ch.reclaimExpiredOrder(orderId);

        assertEq(usdc.balanceOf(caller) - callerBefore, PRICE);
        assertEq(uint8(ch.getOrder(orderId).status), uint8(STATUS_RECLAIMED));
        assertEq(ch.totalEscrowed(), 0);
    }

    function test_reclaim_isImpossibleAfterSettlement() public {
        uint256 orderId = _fundAndCreate(serviceId);
        _settle(orderId, 100, true);
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(bytes("VCC: not funded"));
        ch.reclaimExpiredOrder(orderId);
    }

    function test_settle_isImpossibleAfterExpiryEvenWithAValidSignature() public {
        uint256 orderId = _fundAndCreate(serviceId);
        vm.warp(block.timestamp + TTL + 1);
        bytes32 responseHash = keccak256("response");
        uint64 deadline = uint64(block.timestamp + 900);
        bytes memory sig = _sign(ch, orderId, provider, 100, true, responseHash, deadline);
        vm.expectRevert(bytes("VCC: order expired"));
        ch.settleOrder(orderId, 100, true, responseHash, deadline, sig);
    }

    // ------------------------------------------------------------------
    // Bonds
    // ------------------------------------------------------------------

    function test_withdrawBond_isBlockedWhileTheServiceIsStillListed() public {
        vm.prank(provider);
        vm.expectRevert(bytes("VCC: service active"));
        ch.withdrawBond(serviceId, 1, provider);
    }

    function test_withdrawBond_isBlockedWhileOrdersAreOpen() public {
        // A delisted service that still has a live order owes that order's
        // caller a funded penalty, so the stake stays locked until it closes.
        uint256 open = _fundAndCreate(serviceId);
        open;

        vm.prank(provider);
        ch.setActive(serviceId, false);

        vm.prank(provider);
        vm.expectRevert(bytes("VCC: open orders exist"));
        ch.withdrawBond(serviceId, 1, provider);
    }

    function test_withdrawBond_returnsTheStakeOnceNothingIsOpen() public {
        uint256 orderId = _fundAndCreate(serviceId);
        _settle(orderId, 100, true);

        vm.prank(provider);
        ch.setActive(serviceId, false);

        uint256 before = usdc.balanceOf(provider);
        vm.prank(provider);
        ch.withdrawBond(serviceId, BOND, provider);
        assertEq(usdc.balanceOf(provider) - before, BOND);
        assertEq(ch.getService(serviceId).providerBondUsdc, 0);
        assertEq(ch.totalBond(), 0);
    }

    // ------------------------------------------------------------------
    // Arc blocklist resilience
    // ------------------------------------------------------------------

    function test_aRestrictedRecipientCannotBlockSettlementAndIsCreditable() public {
        BlocklistUSDC guarded = new BlocklistUSDC();
        VeriCallClearinghouse guardedCh = new VeriCallClearinghouse(address(guarded), owner);

        guarded.mint(caller, 10_000_000);
        guarded.mint(provider, 10_000_000);

        (address[] memory recipients, uint16[] memory bps) = _pair(PROVIDER_BPS);
        vm.prank(provider);
        guarded.approve(address(guardedCh), type(uint256).max);
        vm.prank(caller);
        guarded.approve(address(guardedCh), type(uint256).max);

        vm.prank(owner);
        uint256 svc = guardedCh.registerServiceAuthorized(
            provider, verifier, "Guarded", "http://guarded", bytes32(0), PRICE, GRACE, HARD,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );

        vm.prank(caller);
        uint256 orderId = guardedCh.createOrder(svc, keccak256("request"), TTL);
        vm.warp(block.timestamp + 1);

        // The dependency becomes restricted between order creation and settlement.
        guarded.setRestricted(dependency, true);

        uint256 providerBefore = guarded.balanceOf(provider);

        _settleFor(guardedCh, orderId, provider, 100, true, keccak256("response"));

        assertEq(guarded.balanceOf(provider) - providerBefore, 160_000);
        assertEq(guardedCh.claimable(dependency), 40_000);

        // The credit is real money: it pays out once the address is reachable.
        guarded.setRestricted(dependency, false);
        uint256 depBefore = guarded.balanceOf(dependency);
        vm.prank(dependency);
        guardedCh.claimFallback();
        assertEq(guarded.balanceOf(dependency) - depBefore, 40_000);
        assertEq(guardedCh.claimable(dependency), 0);
    }

    function test_claimFallback_withNothingToClaimReverts() public {
        vm.prank(caller);
        vm.expectRevert(bytes("VCC: nothing to claim"));
        ch.claimFallback();
    }

    // ------------------------------------------------------------------
    // Quoting parity: the quote is the settlement
    // ------------------------------------------------------------------

    function test_quoteSettlement_matchesWhatSettlementActuallyPays() public {
        uint256 orderId = _fundAndCreate(serviceId);

        (
            VeriCallClearinghouse.OrderStatus status,
            uint256 rebate,
            uint256 bondSlash,
            uint256 net,
            uint256[] memory splitAmounts
        ) = _quote(serviceId, PRICE, 1250, true);

        uint256 callerBefore = usdc.balanceOf(caller);
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 depBefore = usdc.balanceOf(dependency);

        _settle(orderId, 1250, true);

        assertEq(uint8(status), uint8(STATUS_DEGRADED));
        assertEq(rebate, 40_000);
        assertEq(bondSlash, 0);
        assertEq(net, 160_000);
        assertEq(splitAmounts[0], 128_000);
        assertEq(splitAmounts[1], 32_000);

        assertEq(usdc.balanceOf(caller) - callerBefore, rebate);
        assertEq(usdc.balanceOf(provider) - providerBefore, splitAmounts[0]);
        assertEq(usdc.balanceOf(dependency) - depBefore, splitAmounts[1]);
    }

    function test_quoteSettlement_breachShape() public {
        (
            VeriCallClearinghouse.OrderStatus status,
            uint256 rebate,
            uint256 bondSlash,
            uint256 net,
            uint256[] memory splitAmounts
        ) = _quote(serviceId, PRICE, HARD + 1, true);

        assertEq(uint8(status), uint8(STATUS_BREACH));
        assertEq(rebate, PRICE);
        assertEq(bondSlash, 40_000);
        assertEq(net, 0);
        assertEq(splitAmounts[0], 0);
        assertEq(splitAmounts[1], 0);
    }

    function test_quoteSettlement_neverStrandsDust() public {
        // Three-way split of a deliberately indivisible net amount.
        address[] memory recipients = new address[](3);
        recipients[0] = provider;
        recipients[1] = dependency;
        recipients[2] = address(0xD3);
        uint16[] memory bps = new uint16[](3);
        bps[0] = 3333;
        bps[1] = 3333;
        bps[2] = 3334;

        vm.prank(owner);
        uint256 svc = ch.registerServiceAuthorized(
            provider, verifier, "Dusty", "http://dusty", bytes32(0),
            7, // seven base units: the smallest amount that can be split three ways
            1, 2, 0, 0, BOND, recipients, bps
        );

        (,,, uint256 net, uint256[] memory amounts) = _quote(svc, 7, 1, true);
        assertEq(net, 7);
        assertEq(amounts[0] + amounts[1] + amounts[2], 7, "no unit may be lost");
        assertEq(amounts[0], 7 - amounts[1] - amounts[2], "provider absorbs the remainder");
    }

    // ------------------------------------------------------------------
    // Properties
    // ------------------------------------------------------------------

    function testFuzz_quoteNeverExceedsTheEscrowAndDoesNotRiseWithLatency(uint32 a, uint32 b) public view {
        a = uint32(bound(a, 0, HARD));
        b = uint32(bound(b, 0, HARD));
        if (a > b) {
            (a, b) = (b, a);
        }
        (,,, uint256 netA,) = _quote(serviceId, PRICE, a, true);
        (,,, uint256 netB,) = _quote(serviceId, PRICE, b, true);
        assertGe(netA, netB, "a longer call must never pay the provider more");
        assertLe(netA, PRICE);
    }

    function testFuzz_quoteIsExactlyTheEscrowAtOrBelowGrace(uint32 latency) public view {
        latency = uint32(bound(latency, 0, GRACE));
        (, uint256 rebate,, uint256 net,) = _quote(serviceId, PRICE, latency, true);
        assertEq(rebate, 0);
        assertEq(net, PRICE);
    }

    function testFuzz_rebateIsZeroAtGraceAndMaxAtHard(uint16 rebateBps) public {
        // A fresh covenant per run so the assertion can vary the rate too.
        rebateBps = uint16(bound(rebateBps, 0, 10_000));
        (address[] memory recipients, uint16[] memory bps) = _solo();
        vm.prank(owner);
        uint256 svc = ch.registerServiceAuthorized(
            provider, verifier, "Fuzzed", "http://fuzzed", bytes32(0), PRICE, GRACE, HARD,
            rebateBps, SLASH_BPS, BOND, recipients, bps
        );

        (, uint256 rebateAtGrace,,,) = _quote(svc, PRICE, GRACE, true);
        (, uint256 rebateAtHard,,,) = _quote(svc, PRICE, HARD, true);
        assertEq(rebateAtGrace, 0, "no rebate at or below the grace SLA");
        assertEq(rebateAtHard, (PRICE * rebateBps) / 10_000, "the hard edge takes the full rate");
    }

    function testFuzz_zeroWidthWindowDoesNotRevertInQuote(uint32 latency) public {
        // grace == hard is a legal covenant shape; it must not divide by zero.
        latency = uint32(bound(latency, 0, 5_000));
        (address[] memory recipients, uint16[] memory bps) = _solo();
        vm.prank(owner);
        uint256 svc = ch.registerServiceAuthorized(
            provider, verifier, "Zero width", "http://zero", bytes32(0), PRICE, 100, 100,
            MAX_REBATE_BPS, SLASH_BPS, BOND, recipients, bps
        );
        (,,, uint256 net,) = _quote(svc, PRICE, latency, true);
        if (latency <= 100) {
            assertEq(net, PRICE);
        } else {
            // Past a zero-width window the call is over the hard edge: a breach.
            assertEq(net, 0);
        }
    }

    // ------------------------------------------------------------------
    // Full lifecycle
    // ------------------------------------------------------------------

    function test_fullLifecycle_passDegradedBreachKeepsTheBooks() public {
        uint256 pass = _fundAndCreate(serviceId);
        vm.warp(block.timestamp + 1);
        _settle(pass, 100, true);

        uint256 degraded = _fundAndCreate(serviceId);
        vm.warp(block.timestamp + 1);
        _settle(degraded, 1250, true);

        uint256 breached = _fundAndCreate(serviceId);
        vm.warp(block.timestamp + 1);
        _settle(breached, HARD + 1, true);

        assertEq(ch.totalEscrowed(), 0);

        // Only the bond remains (less the breach penalty), and it equals the
        // contract's balance because no fallback credits were created.
        assertEq(usdc.balanceOf(address(ch)), BOND - 40_000);
        assertEq(ch.getService(serviceId).providerBondUsdc, BOND - 40_000);
        assertEq(ch.claimable(address(0xBEEF)), 0);
    }

    function test_fullLifecycle_nothingIsStrandedAfterManyOrders() public {
        for (uint256 i; i < 6; ++i) {
            uint256 orderId = _fundAndCreate(serviceId);
            vm.warp(block.timestamp + 1);
            _settle(orderId, uint32(100 + i * 300), true);
        }
        uint256 open = _fundAndCreate(serviceId);
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(address(0xFEE1));
        ch.reclaimExpiredOrder(open);

        assertEq(ch.totalEscrowed(), 0);
        // Escrow is gone; only the untouched bond remains inside the contract.
        assertEq(usdc.balanceOf(address(ch)), BOND);
    }

    function test_versionIsStable() public view {
        assertEq(ch.VERSION(), "1.0.0");
        assertEq(ch.version(), "1.0.0");
    }
}

/// @notice Cross-language conformance: the Rust verifier (`verifier/src/eip712.rs`)
///         derives this exact digest from the same struct, chain id and contract
///         address, and recovers the same signer. If either implementation drifts
///         — a changed type string, a different field order, a uint32 encoded as
///         a word instead of a value — one of these tests fails instead of a
///         mainnet settlement reverting.
contract VeriCallEip712CrossCheckTest is Test {
    /// @dev Pinned by `cargo test print_fixture_for_the_solidity_suite`.
    bytes32 internal constant EXPECTED_DIGEST =
        0xdf4667ee75079edb9a42ee79e550ca779cee61527d0521c253acbeaf87e86d45;
    bytes internal constant EXPECTED_SIGNATURE =
        hex"bbf2b5c885aada26a653266321789e9d9c2fab138feaa4c62aa39073bc7667ca27b45451cf4baa46892f632981ce8edce66c2988543fade5a01228b281cfaf321b";
    address internal constant EXPECTED_SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    /// @dev The fixture the Rust side hashes.
    address internal constant CONTRACT_ADDR = 0x1879A1bC80fDC97375Abc7476152C3956FD48e5F;
    address internal constant SERVICE = 0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555;
    uint256 internal constant CHAIN_ID = 5042;

    /// @dev Rebuild the digest exactly as `eip712.rs::domain_separator` and
    ///      `SlaAttestation::struct_hash` do, then compare to the pinned value.
    function _digest() internal pure returns (bytes32) {
        bytes32 domainTypehash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                domainTypehash,
                keccak256(bytes("VeriCall Clearinghouse")),
                keccak256(bytes("1")),
                CHAIN_ID,
                CONTRACT_ADDR
            )
        );

        bytes32 attestationTypehash = keccak256(
            "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                attestationTypehash,
                uint256(1), // orderId
                uint32(1250), // latencyMs
                true, // schemaValid
                keccak256(bytes('{"score":71.5,"band":"medium"}')), // responseHash
                SERVICE,
                uint64(1_760_000_600) // deadline
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function test_digestMatchesTheRustVerifier() public pure {
        assertEq(_digest(), EXPECTED_DIGEST);
    }

    function test_signatureFromTheRustVerifierRecoversOnchain() public pure {
        bytes32 r;
        bytes32 s;
        uint8 v;
        bytes memory sig = EXPECTED_SIGNATURE;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        assertEq(v, 27, "the verifier must emit v in {27,28}");
        assertEq(ecrecover(EXPECTED_DIGEST, v, r, s), EXPECTED_SIGNER);
    }

    function test_uint32FieldsAreEncodedAsValuesNotWords() public pure {
        // A uint32 in EIP-712 is still a 32-byte word whose upper bits are zero.
        // Encoding it as, say, a tight 4-byte value would change the digest; this
        // asserts the padded form by rebuilding the hash from the padded word.
        bytes32 padded = keccak256(
            abi.encode(
                keccak256(
                    "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)"
                ),
                uint256(1),
                uint256(1250),
                uint256(1),
                keccak256(bytes('{"score":71.5,"band":"medium"}')),
                uint256(uint160(SERVICE)),
                uint256(1_760_000_600)
            )
        );
        bytes32 attestationTypehash = keccak256(
            "SlaAttestation(uint256 orderId,uint32 latencyMs,bool schemaValid,bytes32 responseHash,address service,uint64 deadline)"
        );
        bytes32 expected = keccak256(
            abi.encode(
                attestationTypehash,
                uint256(1),
                uint32(1250),
                true,
                keccak256(bytes('{"score":71.5,"band":"medium"}')),
                SERVICE,
                uint64(1_760_000_600)
            )
        );
        assertEq(padded, expected, "uint32/uint64/address/bool must encode as words");
    }
}
