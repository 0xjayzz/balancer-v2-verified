// (c) Kallol Borah, 2022
//"SPDX-License-Identifier: BUSL1.1"

pragma solidity ^0.7.0;

library MarginPoolUserData {
    
    enum JoinKind {
        INIT,
        EXACT_TOKENS_IN_FOR_BPT_OUT, 
        TOKEN_IN_FOR_EXACT_BPT_OUT, 
        ALL_TOKENS_IN_FOR_EXACT_BPT_OUT 
    }
    
    enum ExitKind {
        EMERGENCY_EXACT_BPT_IN_FOR_TOKENS_OUT,
        EXACT_BPT_IN_FOR_TOKENS_OUT
    }

    function exitKind(bytes memory self) internal pure returns (ExitKind) {
        return abi.decode(self, (ExitKind));
    }

    function exactBptInForTokensOut(bytes memory self) internal pure returns (uint256 bptAmountIn) {
        (, bptAmountIn) = abi.decode(self, (ExitKind, uint256));
    }

    function joinKind(bytes memory self) internal pure returns (uint256[] memory maxAmountsIn) {
        (, maxAmountsIn) = abi.decode(self, (JoinKind, uint256[]));
    }
    
}