// Implementation of order book for secondary issues of security tokens that support multiple order types
// (c) Kallol Borah, 2022
//"SPDX-License-Identifier: BUSL1.1"

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "./Heap.sol";
import "hardhat/console.sol";
import "./interfaces/IOrder.sol";
import "./interfaces/ITrade.sol";
import "./interfaces/ISecondaryIssuePool.sol";

import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/Ownable.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IPoolSwapStructs.sol";

contract Orderbook is IOrder, ITrade, Ownable, Heap{
    using FixedPoint for uint256;

    //counter for block timestamp nonce for creating unique order references
    uint256 private _previousTs = 0;

    //mapping order reference to order
    mapping(bytes32 => IOrder.order) private _orders;

    //order references from party to order timestamp
    mapping(address => mapping(uint256 => ITrade.trade)) private _tradeRefs;

    //mapping parties to trade time stamps
    mapping(address => uint256[]) private _trades;

    address private _security;
    address private _currency;
    address payable private _balancerManager;
    address private _pool;

    constructor(address balancerManager, address security, address currency, address pool){        
        _balancerManager = payable(balancerManager);
        _security = security;
        _currency = currency;
        _pool = pool; 
    }

    function getPoolId() external override view returns(bytes32){
        bytes32 _poolId = ISecondaryIssuePool(_pool).getPoolId();
        return _poolId;
    }

    function getSecurity() external override view returns (address) {
        return _security;
    }

    function getCurrency() external override view returns (address) {
        return _currency;
    }

    function newOrder(
        IPoolSwapStructs.SwapRequest memory _request,
        IOrder.Params memory _params
    ) public onlyOwner returns(bytes32){
        require(_params.trade == IOrder.OrderType.Market || _params.trade == IOrder.OrderType.Limit);
        _previousTs = block.timestamp == _previousTs ? _previousTs + 1 : block.timestamp;
        bytes32 ref = keccak256(abi.encodePacked(_request.from, _previousTs));
        //fill up order details
        IOrder.order memory nOrder = IOrder.order({
            tokenIn: address(_request.tokenIn),
            otype: _params.trade,
            status: IOrder.OrderStatus.Open,
            qty: _request.amount,
            party: _request.from
        });
        _orders[ref] = nOrder;        
        if(nOrder.tokenIn==_security)
            //sell order
            insertSellOrder(_params.price, ref);    
        else if(nOrder.tokenIn==_currency)
            //buy order
            insertBuyOrder(_params.price, ref);
        return matchOrders(ref, nOrder, _params.price);
    }

    function editOrder(
        bytes32 ref,
        uint256 _price,
        IPoolSwapStructs.SwapRequest memory _request
    ) public onlyOwner returns(uint256){
        require(_orders[ref].status == IOrder.OrderStatus.Open, "Order is already filled");
        require(_orders[ref].party == _request.from, "Sender is not order creator");
        bool buy = _orders[ref].tokenIn==_security ? false : true;
        editOrderbook(_price, ref, buy);
        uint256 qty = _orders[ref].qty;
        _orders[ref].qty = _request.amount;
        return qty;
    }

    function cancelOrder(bytes32 ref, address sender) public onlyOwner returns(uint256){
        require(_orders[ref].status == IOrder.OrderStatus.Open, "Order is already filled");
        require(_orders[ref].party == sender, "Sender is not order creator");
        bool buy = _orders[ref].tokenIn==_security ? false : true;
        cancelOrderbook(ref, buy);
        uint256 qty = _orders[ref].qty;
        delete _orders[ref];
        return qty;
    }

    //check if a buy order in the order book can execute over the prevailing (low) price passed to the function
    //check if a sell order in the order book can execute under the prevailing (high) price passed to the function
    function checkOrders(bytes32 _ref, uint256 _price) private returns (uint256, Node[] memory){
        uint256 volume;
        Node[] memory _marketOrders;
        _marketOrders = _orders[_ref].tokenIn == _security ? new Node[](_buyOrderbook.length) : new Node[](_sellOrderbook.length);
        uint256 index;
        if(_orders[_ref].tokenIn==_security){
            while (_buyOrderbook.length != 0) {
                uint256 price = getBestBuyPrice();
                if (price == 0) price = _price;
                if (price < _price && _price != 0) break;
                // since this is a sell order, counter offers must offer a better price
                _marketOrders[index] = removeBuyOrder();
                uint256 orderPrice = _marketOrders[index].price > 0 ? _marketOrders[index].price : _price > 0 ? _price : price;
                volume = Math.add(volume, _orders[_marketOrders[index].ref].qty.divDown(orderPrice));
                //if it is a sell order, ie, security in
                if (volume >= _orders[_ref].qty) {
                    //if available market depth exceeds qty to trade, exit and avoid unnecessary lookup through orderbook  
                    return (volume, _marketOrders);
                }
                index++;
            }
        }
        else if(_orders[_ref].tokenIn==_currency){
            while(_sellOrderbook.length!=0 && (getBestSellPrice() <= _price || _price==0)){
                    //since this is a buy order, counter offers to sell must be for lesser price 
                    uint256 price = getBestSellPrice();
                    _marketOrders[index] = removeSellOrder();
                    price = price == 0 ? _price : _marketOrders[index].price;
                    volume = Math.add(volume, price.mulDown(_orders[_marketOrders[index].ref].qty));
                    //if it is a buy order, ie, cash in
                    console.log("Insert in Sell Orderbook", index);
                    if(volume >= _orders[_ref].qty)
                        //if available market depth exceeds qty to trade, exit and avoid unnecessary lookup through orderbook  
                        return (volume, _marketOrders);
                    index++;               
            } 
        }   
        return (volume, _marketOrders); 
    }
        

    //match market orders. Sellers get the best price (highest bid) they can sell at.
    //Buyers get the best price (lowest offer) they can buy at.
    function matchOrders(bytes32 ref, IOrder.order memory _order, uint256 price) private returns (bytes32){
        bytes32 bestBid;
        uint256 bestPrice = 0;
        bytes32 bestOffer;        
        uint256 securityTraded;
        uint256 currencyTraded;
        uint256 i;
        uint256 matches;
        Node[] memory _marketOrders;
        //check if market depth available is non zero
        (matches, _marketOrders) = checkOrders(ref, price);
        if(matches==0){
            return ref;
        }
        else{
            console.log("Size of market orders returned by checkOrders function ", _marketOrders.length);
            console.log("Size of buy order book ", _buyOrderbook.length);
            console.log("Size of sell order book ", _sellOrderbook.length); 
            //size of order book remaining after checkOrders + matches should be = original order book size 
        }
        //if market depth exists, then fill order at one or more price points in the order book
        for (i = 0; i < _marketOrders.length; i++) {
            bytes32 marketOrderRef = _marketOrders[i].ref;
            IOrder.order memory order = _orders[marketOrderRef];
            console.log("Looping through orders, loop number ", i);
            if (_order.qty == 0) break;
            if (marketOrderRef == ref || order.party == _order.party || order.status == IOrder.OrderStatus.Filled) continue;
            if (_marketOrders[i].price == 0 && price == 0) continue;
            if (order.tokenIn == _currency && _order.tokenIn == _security && (_marketOrders[i].price >= price || price == 0 || _marketOrders[i].price == 0)) {
                bestPrice = _marketOrders[i].price == 0 ? price : _marketOrders[i].price;
                bestBid = marketOrderRef;
            } else if (order.tokenIn == _security && _order.tokenIn == _currency && (_marketOrders[i].price <= price || price == 0)) {
                bestPrice = _marketOrders[i].price == 0 ? price : _marketOrders[i].price;
                bestOffer = marketOrderRef;
            }

            if (bestBid != "") {
                if(_order.tokenIn==_security){
                    securityTraded = _orders[bestBid].qty.divDown(bestPrice); // calculating amount of security that can be brought
                    if(securityTraded >= _order.qty){
                        securityTraded = _order.qty;
                        currencyTraded = _order.qty.mulDown(bestPrice);
                        _orders[bestBid].qty = Math.sub(_orders[bestBid].qty, _order.qty);
                        _order.qty = 0;
                        _orders[bestBid].status = _orders[bestBid].qty == 0 ? IOrder.OrderStatus.Filled : IOrder.OrderStatus.PartlyFilled;
                        _order.status = IOrder.OrderStatus.Filled;  
                        reportTrade(ref, bestBid, securityTraded, currencyTraded);
                        insertBuyOrder(bestPrice, bestBid); //reinsert partially unfilled order into orderbook
                    }    
                    else if(securityTraded!=0){
                        currencyTraded = securityTraded.mulDown(bestPrice);
                        _order.qty = Math.sub(_order.qty, securityTraded);
                        _orders[bestBid].qty = 0;
                        _orders[bestBid].status = IOrder.OrderStatus.Filled;
                        _order.status = IOrder.OrderStatus.PartlyFilled;
                        reportTrade(ref, bestBid, securityTraded, currencyTraded);
                    }
                }
            }
            else if (bestOffer != "") {
                if(_order.tokenIn==_currency){
                    currencyTraded = _orders[bestOffer].qty.mulDown(bestPrice); // calculating amount of currency that can taken out    
                    if(currencyTraded >=  _order.qty){
                        currencyTraded = _order.qty;
                        securityTraded = _order.qty.divDown(bestPrice);
                        _orders[bestOffer].qty = Math.sub(_orders[bestOffer].qty, securityTraded);
                        _order.qty = 0;
                        _orders[bestOffer].status = _orders[bestOffer].qty == 0 ? IOrder.OrderStatus.Filled : IOrder.OrderStatus.PartlyFilled;
                        _order.status = IOrder.OrderStatus.Filled;  
                        reportTrade(ref, bestOffer, securityTraded, currencyTraded);
                        insertSellOrder(bestPrice, bestOffer); //reinsert partially unfilled order into orderbook
                    }    
                    else if(currencyTraded!=0){
                        securityTraded = currencyTraded.divDown(bestPrice);
                        _order.qty = Math.sub(_order.qty, currencyTraded);
                        _orders[bestOffer].qty = 0;
                        _orders[bestOffer].status = IOrder.OrderStatus.Filled;
                        _order.status = IOrder.OrderStatus.PartlyFilled;    
                        reportTrade(ref, bestOffer, securityTraded, currencyTraded);                    
                    }                    
                }
            }
        }
        //remove filled order from orderbook
        if(_order.status == IOrder.OrderStatus.Filled){
            bool buy = _order.tokenIn==_security ? false : true;
            cancelOrderbook(ref, buy);
        }
        return ref;
    }
    
    function reportTrade(bytes32 _ref, bytes32 _cref, uint256 securityTraded, uint256 currencyTraded) private {
        _previousTs = _previousTs + 1;
        uint256 oIndex = _previousTs;
        ITrade.trade memory tradeToReport = ITrade.trade({
            partyRef: _ref,
            partyAddress:  _orders[_ref].party,
            counterpartyRef: _cref,            
            dt: oIndex,
            securityTraded: securityTraded,
            currencyTraded: currencyTraded
        });                 
        _tradeRefs[_orders[_ref].party][oIndex] = tradeToReport;
        _tradeRefs[_orders[_cref].party][oIndex] = tradeToReport;        
        _trades[_orders[_ref].party].push(tradeToReport.dt);
        _trades[_orders[_cref].party].push(tradeToReport.dt);
    }

    function getOrder(bytes32 _ref) external override view returns(IOrder.order memory){
        require(msg.sender==owner() || msg.sender==_balancerManager || msg.sender==_orders[_ref].party, "Unauthorized access to orders");
        return _orders[_ref];
    }

    function getTrade(address _party, uint256 _timestamp) external override view returns(ITrade.trade memory){
        require(msg.sender==owner() || msg.sender==_party, "Unauthorized access to trades");
        return _tradeRefs[_party][_timestamp];
    }

    function getTrades() external override view returns(uint256[] memory){
        return _trades[msg.sender];
    }

    function removeTrade(address _party, uint256 _timestamp) public onlyOwner {
        for(uint256 i=0; i<_trades[_party].length; i++){
            if(_trades[_party][i]==_timestamp)
                delete _trades[_party][i];
        }
    }
    
    //remove this function using unbounded for loop, use the subgraph instead
    function getOrderRef() external override view returns (bytes32[] memory) {
        bytes32[] memory refs = new bytes32[](_sellOrderbook.length);
        uint256 i;
        for(uint256 j=0; j<_sellOrderbook.length; j++){
            if(_orders[_sellOrderbook[j].ref].party==msg.sender){
                refs[i] = _sellOrderbook[j].ref;
                i++;
            }
        }
        return refs;
    }

    function revertTrade(
        bytes32 _orderRef,
        uint256 _qty,
        uint256 _price
    ) external override {
        require(msg.sender==_balancerManager || msg.sender==owner(), "Unauthorized access");
        _orders[_orderRef].qty = _orders[_orderRef].qty + _qty;
        _orders[_orderRef].status = OrderStatus.Open;
        //push to order book
        if(_orders[_orderRef].tokenIn==_security)
            //sell order
            insertSellOrder(_price, _orderRef);    
        else if(_orders[_orderRef].tokenIn==_currency)
            //buy order
            insertBuyOrder(_price, _orderRef);
    }

    function orderFilled(bytes32 partyRef, bytes32 counterpartyRef, uint256 executionDate) external override {
        require(msg.sender==_balancerManager || msg.sender==owner(), "Unauthorized access");
        delete _orders[partyRef];
        delete _orders[counterpartyRef];
        delete _tradeRefs[_orders[partyRef].party][executionDate];
        delete _tradeRefs[_orders[counterpartyRef].party][executionDate];
    }

}