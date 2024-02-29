// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestToken is ERC20 {
    // Constructor
    constructor() ERC20("TestToken", "TEST") {
        // Mint initial supply and allocate to the contract deployer
        _mint(msg.sender, 1000000 * (10**decimals()));
    }
}
