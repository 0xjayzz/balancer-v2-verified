import { BigNumber } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { BigNumberish } from '../../../../numbers';
import { Address } from 'cluster';

export type EditOrder = {
  ref?: string;
  amount: BigNumberish;
  from?: SignerWithAddress;
};

export type CancelOrder = {
  ref?: string;
  from?: SignerWithAddress;
};

export type OrderRef = {
  from?: SignerWithAddress;
};

export type TradeFetch = {
  from?: SignerWithAddress;
  executionDate: BigNumberish;
};

export type OrderBookRef = {
  from?: SignerWithAddress;
  ref?: string;
};

export type RevertTrade = {
  from?: SignerWithAddress;
  executionDate: BigNumberish; 
};