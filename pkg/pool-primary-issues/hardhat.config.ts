import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';

import { hardhatBaseConfig } from '@balancer-labs/v2-common';
import { name } from './package.json';

import { task } from 'hardhat/config';
import { TASK_COMPILE } from 'hardhat/builtin-tasks/task-names';
import overrideQueryFunctions from '@balancer-labs/v2-helpers/plugins/overrideQueryFunctions';
import "hardhat-gas-reporter";

task(TASK_COMPILE).setAction(overrideQueryFunctions);
module.exports = {
  networks: {
    hardhat: {},
    goerli: {
      url: "https://goerli.infura.io/v3/9209042058744582bcfe75db6d54c4d5", // My Infura project ID
      accounts: ["0x4e44f7691f6c2789851d97379b89524214703c11212354e3e3e202e54b8b8567"], // Added my private keys for testing
    },
  },
export default {
  solidity: {
    compilers: hardhatBaseConfig.compilers,
    overrides: { ...hardhatBaseConfig.overrides(name) },
  },
  gasReporter: {
    enabled: true,
    currency: 'USD',
    coinmarketcap: "91114b84-bec7-4d68-8cbf-c52a834105f9",
    token: 'ETH',
    gasPriceApi: 'https://api.etherscan.io/api?module=proxy&action=eth_gasPrice',
    showTimeSpent: true,
    showMethodSig: true,
  }
};
