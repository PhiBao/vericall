// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Test doubles for the ERC-20 USDC interface on Arc.
/// @notice Two behaviours matter for settlement safety and both are modelled
///         here rather than assumed:
///
///         * `MockUSDC` — a normal 6-decimal token, so the arithmetic is
///           exercised against realistic magnitudes.
///         * `BlocklistUSDC` — a token that reverts for specific addresses,
///           which is how Arc's protocol-level USDC blocklist presents itself to
///           a contract. A settlement that pushes to three recipients must
///           survive one of them being restricted.

interface ITestERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
    function mint(address, uint256) external;
}

contract MockUSDC is ITestERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external virtual {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A token that reverts on any movement to or from a restricted address,
///         mirroring Arc's runtime blocklist enforcement.
contract BlocklistUSDC is MockUSDC {
    mapping(address => bool) public restricted;

    function setRestricted(address account, bool value) external {
        restricted[account] = value;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(!restricted[msg.sender] && !restricted[to], "blocklisted");
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(!restricted[from] && !restricted[to], "blocklisted");
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        return _move(from, to, amount);
    }
}
