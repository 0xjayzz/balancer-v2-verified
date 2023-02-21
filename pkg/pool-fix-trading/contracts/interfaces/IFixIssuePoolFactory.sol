// Factory interface to create pools of FIX issues for security token offerings
//"SPDX-License-Identifier: BUSL1.1"

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

interface IFixIssuePoolFactory {

    function create(
        string calldata name,
        string calldata symbol,
        address security,
        address currency,
        uint256 maxAmountsIn,
        uint256 tradeFeePercentage
    ) external returns (address);

}