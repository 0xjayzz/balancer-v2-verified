// Implementation of pool for secondary issues of security tokens that support multiple order types
// (c) Kallol Borah, 2022
//"SPDX-License-Identifier: BUSL1.1"

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "./interfaces/IOrder.sol";
import "./interfaces/ITrade.sol";
import "./interfaces/ISettlor.sol";
import "./Orderbook.sol";

import "@balancer-labs/v2-pool-utils/contracts/BasePool.sol";

import "@balancer-labs/v2-solidity-utils/contracts/helpers/ERC20Helpers.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/SafeERC20.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";

import "@balancer-labs/v2-interfaces/contracts/pool-secondary/SecondaryPoolUserData.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IGeneralPool.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/helpers/BalancerErrors.sol";
import "hardhat/console.sol";
contract SecondaryIssuePool is BasePool, IGeneralPool {
    using SecondaryPoolUserData for bytes;
    using SafeERC20 for IERC20;
    using FixedPoint for uint256;

    Orderbook public _orderbook;
    
    address private immutable _security;
    address private immutable _currency;

    uint256 private constant _TOTAL_TOKENS = 3; //Security token, Currency token (ie, paired token), Balancer pool token

    uint256 private constant _INITIAL_BPT_SUPPLY = 2**(112) - 1;

    uint256 private immutable _scalingFactorSecurity;
    uint256 private immutable _scalingFactorCurrency;

    uint256 private _MIN_ORDER_SIZE;
    //uint256 private immutable _swapFee;

    //uint256 private immutable _bptIndex;
    uint256 private immutable _securityIndex;
    uint256 private immutable _currencyIndex;

    address payable immutable private _balancerManager;
    IVault _vault;
    
    event TradeReport(
        address indexed security,
        bytes32 orderRef,
        address party,
        address counterparty,
        bytes32 orderType,
        uint256 price,
        address currency,
        uint256 amount,
        uint256 executionDate
    );

    event OrderBook(address creator, address tokenIn, address tokenOut, uint256 amountOffered, uint256 priceOffered, uint256 timestamp, bytes32 orderRef);

    event Offer(address indexed security, uint256 minOrderSize, address currency, address orderBook, address issueManager);  

    constructor(
        IVault vault,
        string memory name,
        string memory symbol,
        address security,
        address currency,
        uint256 minOrderSize,
        uint256 tradeFeePercentage,
        uint256 pauseWindowDuration,
        uint256 bufferPeriodDuration,
        address owner
    )
        BasePool(
            vault,
            IVault.PoolSpecialization.GENERAL,
            name,
            symbol,
            _sortTokens(IERC20(security), IERC20(currency), IERC20(this)),
            new address[](_TOTAL_TOKENS),
            tradeFeePercentage,
            pauseWindowDuration,
            bufferPeriodDuration,
            owner
        )
    {
        // set tokens
        _security = security;
        _currency = currency;
        _vault = vault;
        // Set token indexes
        (uint256 securityIndex, uint256 currencyIndex, /*uint256 bptIndex*/) = _getSortedTokenIndexes(
            IERC20(security),
            IERC20(currency),
            IERC20(this)
        );
        //_bptIndex = bptIndex;
        _securityIndex = securityIndex;
        _currencyIndex = currencyIndex;

        // set scaling factors
        _scalingFactorSecurity = _computeScalingFactor(IERC20(security));
        _scalingFactorCurrency = _computeScalingFactor(IERC20(currency));

        _MIN_ORDER_SIZE = minOrderSize;

        //swap fee
        //_swapFee = tradeFeePercentage;

        _balancerManager = payable(owner);

        _orderbook = new Orderbook(payable(owner), security, currency, address(this));

        emit Offer(security, minOrderSize, currency, address(_orderbook), owner);
    }

    function getSecurity() external view returns (address) {
        return _security;
    }

    function getCurrency() external view returns (address) {
        return _currency;
    }

    function getMinOrderSize() external view returns (uint256) {
        return _MIN_ORDER_SIZE;
    }

    function onSwap(
        SwapRequest memory request,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) public override onlyVault(request.poolId) whenNotPaused returns (uint256) {
        require (request.kind == IVault.SwapKind.GIVEN_IN || request.kind == IVault.SwapKind.GIVEN_OUT, "Invalid swap");
        require(request.tokenOut == IERC20(_currency) ||
                request.tokenOut == IERC20(_security) ||
                request.tokenIn == IERC20(_currency) ||
                request.tokenIn == IERC20(_security), "Invalid swapped tokens");

        uint256[] memory scalingFactors = _scalingFactors();
        _upscaleArray(balances, scalingFactors);
        IOrder.Params memory params;

        string memory otype;
        uint256 tp;
        bytes32 tradeRef;
        uint256 amount;        

        if (request.kind == IVault.SwapKind.GIVEN_IN) 
            request.amount = _upscale(request.amount, scalingFactors[indexIn]);
        else if (request.kind == IVault.SwapKind.GIVEN_OUT)
            request.amount = _upscale(request.amount, scalingFactors[indexOut]);

        if(request.tokenIn==IERC20(_currency) && request.kind==IVault.SwapKind.GIVEN_IN)
            require(balances[_currencyIndex]>=request.amount, "Insufficient currency balance");
        else if(request.tokenIn==IERC20(_security) && request.kind==IVault.SwapKind.GIVEN_IN)
            require(balances[_securityIndex]>=request.amount, "Insufficient security balance");

        if(request.userData.length!=0){
            (otype, tp) = abi.decode(request.userData, (string, uint256));  
            if(bytes(otype).length==0){               
                ITrade.trade memory tradeToReport = _orderbook.getTrade(request.from, tp);
                tradeRef = _orderbook.getOrder(tradeToReport.partyAddress == request.from 
                                            ? tradeToReport.partyRef : tradeToReport.counterpartyRef)
                                            //.tokenIn==_security? bytes32("security") : bytes32("currency");        
                                            .swapKind==IVault.SwapKind.GIVEN_IN ? bytes32("security") : bytes32("currency");                
                if(request.tokenIn==IERC20(_security) && request.kind==IVault.SwapKind.GIVEN_IN ||
                    request.tokenOut==IERC20(_security) && request.kind==IVault.SwapKind.GIVEN_OUT
                ){
                    amount = tradeToReport.currencyTraded;
                }
                else if(request.tokenIn==IERC20(_currency) && request.kind==IVault.SwapKind.GIVEN_IN ||
                    request.tokenOut==IERC20(_currency) && request.kind==IVault.SwapKind.GIVEN_OUT
                ){
                    amount = tradeToReport.securityTraded;
                }
                bytes32 orderType;
                if (request.tokenOut == IERC20(_currency) || request.tokenIn == IERC20(_security)) {
                    orderType = "Sell";
                } 
                else if (request.tokenOut == IERC20(_security) || request.tokenIn == IERC20(_currency)) {
                    orderType = "Buy";
                }
                emit TradeReport(
                    _security,
                    tradeRef,
                    tradeRef==bytes32("security") ? _orderbook.getOrder(tradeToReport.partyRef).party : _orderbook.getOrder(tradeToReport.counterpartyRef).party,
                    tradeRef==bytes32("currency") ? _orderbook.getOrder(tradeToReport.partyRef).party : _orderbook.getOrder(tradeToReport.counterpartyRef).party,
                    orderType,
                    //tradeToReport.price,
                    tradeToReport.currencyTraded.divDown(tradeToReport.securityTraded),                    
                    _currency,
                    amount,
                    tradeToReport.dt
                );
                tradeToReport.securityTraded = _downscaleDown(tradeToReport.securityTraded, _scalingFactorSecurity);
                tradeToReport.currencyTraded = _downscaleDown(tradeToReport.currencyTraded, _scalingFactorCurrency);
                //ISettlor(_balancerManager).requestSettlement(tradeToReport, _orderbook);
                _orderbook.removeTrade(request.from, tp);
                if(request.kind == IVault.SwapKind.GIVEN_IN){
                    if (request.tokenIn == IERC20(_security) || request.tokenIn == IERC20(_currency)) {
                        return _downscaleDown(amount, scalingFactors[indexOut]);
                    }
                }
                else if(request.kind == IVault.SwapKind.GIVEN_OUT) {
                    if (request.tokenOut == IERC20(_security) || request.tokenOut == IERC20(_currency)) {
                        return _downscaleDown(amount, scalingFactors[indexIn]);
                    }
                }
            }
        }else{ 
            //by default, any order without price specified is a market order
            params = IOrder.Params({
                trade: IOrder.OrderType.Market,
                price: 0
            });
        }  

        if(params.trade == IOrder.OrderType.Market){
            require(request.amount >= _MIN_ORDER_SIZE, "Order below minimum size");

            //we are placing only market orders using onSwap() now and using it to settle limit orders
            if (/*request.tokenOut == IERC20(_currency) ||*/ request.tokenIn == IERC20(_security)) {
                console.log("Sell");
                (tradeRef, tp, amount) = _orderbook.newOrder(request, params);//, IOrder.Order.Sell);
            } 
            else if (request.tokenOut == IERC20(_security) /*|| request.tokenIn == IERC20(_currency)*/) {
                console.log("BUY");
                (tradeRef, tp, amount) = _orderbook.newOrder(request, params);//, IOrder.Order.Buy);
            }
            else{
                _revert(Errors.UNHANDLED_BY_SECONDARY_POOL);
            }

            require(amount!=0, "Insufficient liquidity");
            emit OrderBook(request.from, address(request.tokenIn), address(request.tokenOut), request.amount, params.price, tp, tradeRef);

            bytes32 orderType;
            uint256 price;
            if(/*request.tokenOut == IERC20(_currency) ||*/ request.tokenIn == IERC20(_security)){
                orderType = "Sell";
                price = amount.divDown(request.amount);
            }
            else if(request.tokenOut == IERC20(_security) /*|| request.tokenIn == IERC20(_currency)*/){
                orderType = "Buy";
                price = request.amount.divDown(amount);
            }
            /*emit TradeReport(
                _security,
                tradeRef,
                request.from,
                address(0),
                orderType,
                price,
                _currency,
                amount,
                tp
            );*/
            if(request.kind == IVault.SwapKind.GIVEN_IN){
                if (request.tokenIn == IERC20(_security) /*|| request.tokenIn == IERC20(_currency)*/) {
                    return _downscaleDown(amount, scalingFactors[indexOut]);
                }
            }
            else if(request.kind == IVault.SwapKind.GIVEN_OUT) {
                if (request.tokenOut == IERC20(_security) /*|| request.tokenOut == IERC20(_currency)*/) {
                    return _downscaleDown(amount, scalingFactors[indexIn]);
                }
            }            
        }
        
    }

    function onLimit(
        IVault.SwapKind kind,
        bytes32 poolId,
        uint256 amount,
        bytes memory data,
        uint256 indexIn,
        uint256 indexOut
    ) public whenNotPaused returns (uint256) {
        (, uint256[] memory balances,) = IVault(_vault).getPoolTokens(poolId);
        IERC20 tokenIn = indexIn == _securityIndex ? IERC20(_security) : IERC20(_currency);
        IERC20 tokenOut = indexOut == _securityIndex ? IERC20(_security) : IERC20(_currency);
        SwapRequest memory request;
        request.kind = kind;
        request.tokenIn = tokenIn;
        request.tokenOut = tokenOut;
        request.amount = amount;
        request.userData = data;
        request.from = msg.sender;

        require (request.kind == IVault.SwapKind.GIVEN_IN || request.kind == IVault.SwapKind.GIVEN_OUT, "Invalid swap");
        require(request.tokenOut == IERC20(_currency) ||
                request.tokenOut == IERC20(_security) ||
                request.tokenIn == IERC20(_currency) ||
                request.tokenIn == IERC20(_security), "Invalid swapped tokens");

        uint256[] memory scalingFactors = _scalingFactors();
        _upscaleArray(balances, scalingFactors);
        IOrder.Params memory params;

        string memory otype;
        uint256 tp;
        bytes32 orderRef;

        if (request.kind == IVault.SwapKind.GIVEN_IN) 
            request.amount = _upscale(request.amount, scalingFactors[indexIn]);
        else if (request.kind == IVault.SwapKind.GIVEN_OUT)
            request.amount = _upscale(request.amount, scalingFactors[indexOut]);

        if(request.tokenIn==IERC20(_currency) && request.kind==IVault.SwapKind.GIVEN_IN)
            require(balances[_currencyIndex]>=request.amount, "Insufficient currency balance");
        else if(request.tokenIn==IERC20(_security) && request.kind==IVault.SwapKind.GIVEN_IN)
            require(balances[_securityIndex]>=request.amount, "Insufficient security balance");

        if(request.userData.length!=0){
            (otype, tp) = abi.decode(request.userData, (string, uint256));  
            if(bytes(otype).length!=0){               
                if(tp!=0){ //any order where price is indicated is a limit order
                    params = IOrder.Params({
                        trade: IOrder.OrderType.Limit,
                        price: tp 
                    });                    
                }
            }                  
        }              

        require(request.amount >= _MIN_ORDER_SIZE, "Order below minimum size");        

        if (/*request.tokenOut == IERC20(_currency) ||*/ request.tokenIn == IERC20(_security)) {
            (orderRef, , ) = _orderbook.newOrder(request, params);//, IOrder.Order.Sell);
        } 
        else if (request.tokenOut == IERC20(_security) /*|| request.tokenIn == IERC20(_currency)*/) {
            (orderRef, , ) = _orderbook.newOrder(request, params);//, IOrder.Order.Buy);
        }
        else {
            _revert(Errors.UNHANDLED_BY_SECONDARY_POOL);
        }
            
        emit OrderBook(request.from, address(request.tokenIn), address(request.tokenOut), request.amount, params.price, block.timestamp, orderRef);
    }

    function _onInitializePool(
        bytes32,
        address sender,
        address recipient,
        uint256[] memory,
        bytes memory userData
    ) internal view override whenNotPaused returns (uint256, uint256[] memory) {
        //on initialization, pool simply premints max BPT supply possible
        address balancerManager = _balancerManager;
        _require(sender == balancerManager, Errors.INVALID_INITIALIZATION);
        _require(recipient == payable(balancerManager), Errors.INVALID_INITIALIZATION);

        uint256 bptAmountOut = _INITIAL_BPT_SUPPLY;
        uint256[] memory amountsIn = userData.joinKind();
        amountsIn[_currencyIndex] = _upscale(amountsIn[_currencyIndex], _scalingFactorCurrency);

        return (bptAmountOut, amountsIn);
    }

    function _onJoinPool(
        bytes32,
        address,
        address,
        uint256[] memory,
        uint256,
        uint256,
        uint256[] memory,
        bytes memory
    ) internal pure override returns (uint256, uint256[] memory) {
        //joins are not supported as this pool supports an order book only
        _revert(Errors.UNHANDLED_BY_SECONDARY_POOL);
    }

    function _onExitPool(
        bytes32,
        address,
        address,
        uint256[] memory balances,
        uint256,
        uint256,
        uint256[] memory,
        bytes memory userData
    ) internal view override returns (uint256 bptAmountIn, uint256[] memory amountsOut) {
        SecondaryPoolUserData.ExitKind kind = userData.exitKind();
        if (kind != SecondaryPoolUserData.ExitKind.EXACT_BPT_IN_FOR_TOKENS_OUT) {
            //usually exit pool reverts
            _revert(Errors.UNHANDLED_BY_SECONDARY_POOL);
        } else {
            (bptAmountIn, amountsOut) = _exit(balances, userData);
        }
    }

    function _exit(uint256[] memory balances, bytes memory userData)
        private
        view
        returns (uint256, uint256[] memory)
    {   
        // This proportional exit function is only enabled if the contract is paused, to provide users a way to
        // retrieve their tokens in case of an emergency.
        uint256 bptAmountIn = userData.exactBptInForTokensOut();
        uint256[] memory amountsOut = new uint256[](balances.length);
        for (uint256 i = 0; i < balances.length; i++) {
            // BPT is skipped as those tokens are not the LPs, but rather the preminted and undistributed amount.
            //if (i != _bptIndex) {
            if (i == _currencyIndex || i == _securityIndex) {
                amountsOut[i] = balances[i];
            }
        }

        return (bptAmountIn, amountsOut);
    }

    function _getMaxTokens() internal pure override returns (uint256) {
        return _TOTAL_TOKENS;
    }

    function _getTotalTokens() internal view virtual override returns (uint256) {
        return _TOTAL_TOKENS;
    }

    function _scalingFactor(IERC20 token) internal view virtual override returns (uint256) {
        if (token == IERC20(_security)){
            return _scalingFactorSecurity;
        }
        else if(token == IERC20(_currency)){
            return _scalingFactorCurrency;
        } else {
            _revert(Errors.INVALID_TOKEN);
        }
    }

    function _scalingFactors() internal view virtual override returns (uint256[] memory) {
        uint256 numTokens = _getMaxTokens();
        uint256[] memory scalingFactors = new uint256[](numTokens);
        for(uint256 i = 0; i < numTokens; i++) {
            if(i==_securityIndex){
                scalingFactors[i] = _scalingFactorSecurity;
            }
            else if(i==_currencyIndex){
                scalingFactors[i] = _scalingFactorCurrency;
            }
            else {//if(i==_bptIndex){
                scalingFactors[i] = FixedPoint.ONE;
            }
        }
        return scalingFactors;
    }

}
