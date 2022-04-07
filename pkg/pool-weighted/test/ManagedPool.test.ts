import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { bn, fp, fromFp, pct } from '@balancer-labs/v2-helpers/src/numbers';
import { MINUTE, DAY, advanceTime, currentTimestamp, WEEK } from '@balancer-labs/v2-helpers/src/time';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { ManagedPoolEncoder, SwapKind } from '@balancer-labs/balancer-js';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { SwapKind } from '@balancer-labs/balancer-js';

import { range } from 'lodash';

describe('ManagedPool', function () {
  let allTokens: TokenList;
  let poolTokens: TokenList;
  let tooManyWeights: BigNumber[];
  let admin: SignerWithAddress, owner: SignerWithAddress, other: SignerWithAddress;
  let mockAssetManager: SignerWithAddress;
  let pool: WeightedPool;

  before('setup signers', async () => {
    [, admin, owner, other, mockAssetManager] = await ethers.getSigners();
  });

  const MAX_TOKENS = 38;
  const TOKEN_COUNT = 20;

  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const POOL_MANAGEMENT_SWAP_FEE_PERCENTAGE = fp(0.7);
  const NEW_MANAGEMENT_SWAP_FEE_PERCENTAGE = fp(0.8);
  const WEIGHTS = range(10000, 10000 + MAX_TOKENS); // These will be normalized to weights that are close to each other, but different

  const poolWeights: BigNumber[] = Array(TOKEN_COUNT).fill(fp(1 / TOKEN_COUNT)); //WEIGHTS.slice(0, TOKEN_COUNT).map(fp);
  const initialBalances = Array(TOKEN_COUNT).fill(fp(1000));
  let sender: SignerWithAddress;

  sharedBeforeEach('deploy tokens', async () => {
    allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true, varyDecimals: true });
    tooManyWeights = Array(allTokens.length).fill(fp(0.01));
    poolTokens = allTokens.subset(20);
    await poolTokens.mint({ to: [other], amount: fp(2000) });
  });

  function itComputesWeightsAndScalingFactors(weightSum = 1): void {
    describe('weights and scaling factors', () => {
      for (const numTokens of range(2, MAX_TOKENS + 1)) {
        context(`with ${numTokens} tokens and a totalWeight of ${weightSum}`, () => {
          let tokens: TokenList;

          sharedBeforeEach('deploy pool', async () => {
            tokens = allTokens.subset(numTokens);

            pool = await WeightedPool.create({
              poolType: WeightedPoolType.MANAGED_POOL,
              tokens,
              weights: WEIGHTS.slice(0, numTokens),
              swapFeePercentage: POOL_SWAP_FEE_PERCENTAGE,
              managementSwapFeePercentage: POOL_MANAGEMENT_SWAP_FEE_PERCENTAGE,
            });
          });

          it('has the correct total weight', async () => {
            expect(await pool.instance.getDenormWeightSum()).to.equal(fp(weightSum));
          });

          it('sets token weights', async () => {
            const normalizedWeights = await pool.getNormalizedWeights();

            for (let i = 0; i < numTokens; i++) {
              expectEqualWithError(normalizedWeights[i], pool.normalizedWeights[i], 0.0000001);
            }
          });

          it('sets scaling factors', async () => {
            const poolScalingFactors = await pool.getScalingFactors();
            const tokenScalingFactors = tokens.map((token) => fp(10 ** (18 - token.decimals)));

            expect(poolScalingFactors).to.deep.equal(tokenScalingFactors);
          });
        });
      }
    });
  }

  itComputesWeightsAndScalingFactors();

  context('with invalid creation parameters', () => {
    it('fails with < 2 tokens', async () => {
      const params = {
        tokens: allTokens.subset(1),
        weights: [fp(0.3)],
        poolType: WeightedPoolType.MANAGED_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('MIN_TOKENS');
    });

    it('fails with > MAX_TOKENS tokens', async () => {
      const params = {
        tokens: allTokens,
        weights: tooManyWeights,
        poolType: WeightedPoolType.MANAGED_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('MAX_TOKENS');
    });

    it('fails with mismatched tokens/weights', async () => {
      const params = {
        tokens: allTokens.subset(20),
        weights: tooManyWeights,
        poolType: WeightedPoolType.MANAGED_POOL,
      };
      await expect(WeightedPool.create(params)).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
    });
  });

  context('when deployed from factory', () => {
    sharedBeforeEach('deploy pool', async () => {
      const params = {
        tokens: poolTokens,
        weights: poolWeights,
        poolType: WeightedPoolType.MANAGED_POOL,
        from: owner,
        fromFactory: true,
      };
      pool = await WeightedPool.create(params);
    });

    it('has zero asset managers', async () => {
      await poolTokens.asyncEach(async (token) => {
        const info = await pool.getTokenInfo(token);
        expect(info.assetManager).to.eq(ZERO_ADDRESS);
      });
    });
  });

  describe('when initialized with an LP allowlist', () => {
    sharedBeforeEach('deploy pool', async () => {
      const params = {
        tokens: poolTokens,
        weights: poolWeights,
        poolType: WeightedPoolType.MANAGED_POOL,
        swapEnabledOnStart: true,
        mustAllowlistLPs: true,
        owner: owner.address,
      };
      pool = await WeightedPool.create(params);
    });

    it('shows mustAllowlistLPs on and active', async () => {
      expect(await pool.getMustAllowlistLPs()).to.be.true;
      expect(await pool.isAllowedAddress(owner.address)).to.be.false;
      expect(await pool.isAllowedAddress(other.address)).to.be.false;
    });

    context('when an address is added to the allowlist', () => {
      sharedBeforeEach('add address to allowlist', async () => {
        const receipt = await pool.addAllowedAddress(owner, other.address);

        expectEvent.inReceipt(await receipt.wait(), 'AllowlistAddressAdded', {
          member: other.address,
        });

        await pool.init({ from: other, initialBalances });
      });

      it('the LP address is on the list', async () => {
        expect(await pool.isAllowedAddress(other.address)).to.be.true;
        expect(await pool.isAllowedAddress(owner.address)).to.be.false;
      });

      it('an address cannot be added twice', async () => {
        await expect(pool.addAllowedAddress(owner, other.address)).to.be.revertedWith('ADDRESS_ALREADY_ALLOWLISTED');
      });

      it('the listed LP can join', async () => {
        const startingBpt = await pool.balanceOf(other);

        const { amountsIn } = await pool.joinAllGivenOut({ from: other, bptOut: startingBpt });

        expect(amountsIn).to.deep.equal(initialBalances);
      });

      it('addresses not on the list cannot join', async () => {
        const startingBpt = await pool.balanceOf(owner);

        await expect(pool.joinAllGivenOut({ from: owner, bptOut: startingBpt })).to.be.revertedWith(
          'ADDRESS_NOT_ALLOWLISTED'
        );
      });

      it('retains the allowlist when turned off and back on', async () => {
        // Initial state: allowlist is on, and the owner is not on it
        expect(await pool.isAllowedAddress(owner.address)).to.be.false;

        // Open up for public LPs
        await pool.setMustAllowlistLPs(owner, false);
        // Owner is now allowed
        expect(await pool.isAllowedAddress(owner.address)).to.be.true;

        // Turn the allowlist back on
        await pool.setMustAllowlistLPs(owner, true);

        // Owner is not allowed again
        expect(await pool.isAllowedAddress(owner.address)).to.be.false;
        // Other is still on the allowlist from before
        expect(await pool.isAllowedAddress(other.address)).to.be.true;
      });

      context('when an address is removed', () => {
        sharedBeforeEach('remove address from allowlist', async () => {
          const receipt = await pool.removeAllowedAddress(owner, other.address);

          expectEvent.inReceipt(await receipt.wait(), 'AllowlistAddressRemoved', {
            member: other.address,
          });
        });

        it('the LP address is no longer on the list', async () => {
          expect(await pool.isAllowedAddress(other.address)).to.be.false;
          expect(await pool.isAllowedAddress(owner.address)).to.be.false;
        });

        it('reverts when removing an address not on the list', async () => {
          await expect(pool.removeAllowedAddress(owner, other.address)).to.be.revertedWith('ADDRESS_NOT_ALLOWLISTED');
        });
      });
    });

    context('when mustAllowlistLPs is toggled', () => {
      sharedBeforeEach('initialize pool', async () => {
        await pool.init({ from: owner, initialBalances });
      });

      it('allowlist is initially on', async () => {
        const startingBpt = await pool.balanceOf(owner);

        expect(await pool.getMustAllowlistLPs()).to.be.true;
        await expect(pool.joinAllGivenOut({ from: owner, bptOut: startingBpt })).to.be.revertedWith(
          'ADDRESS_NOT_ALLOWLISTED'
        );
      });

      it('allows owner to turn it off (open to public LPs)', async () => {
        const startingBpt = await pool.balanceOf(owner);

        const receipt = await pool.setMustAllowlistLPs(owner, false);
        expectEvent.inReceipt(await receipt.wait(), 'MustAllowlistLPsSet', {
          mustAllowlistLPs: false,
        });

        // Should be turned off
        expect(await pool.getMustAllowlistLPs()).to.be.false;

        // And allow joins from anywhere
        await expect(pool.joinAllGivenOut({ from: other, bptOut: startingBpt })).to.not.be.reverted;

        // Does not allow adding addresses now
        await expect(pool.addAllowedAddress(owner, other.address)).to.be.revertedWith('UNAUTHORIZED_OPERATION');
        await expect(pool.removeAllowedAddress(owner, other.address)).to.be.revertedWith('ADDRESS_NOT_ALLOWLISTED');
      });

      it('reverts if non-owner tries to enable public LPs', async () => {
        await expect(pool.setMustAllowlistLPs(other, false)).to.be.revertedWith('SENDER_NOT_ALLOWED');
      });
    });
  });

  describe('with valid creation parameters', () => {
    context('when initialized with swaps disabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: false,
        };
        pool = await WeightedPool.create(params);
      });

      it('swaps show disabled on start', async () => {
        expect(await pool.instance.getSwapEnabled()).to.be.false;
      });

      it('swaps are blocked', async () => {
        await expect(pool.swapGivenIn({ in: 1, out: 0, amount: fp(0.1) })).to.be.revertedWith('SWAPS_DISABLED');
      });
    });

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      it('swaps show enabled on start', async () => {
        expect(await pool.instance.getSwapEnabled()).to.be.true;
      });

      it('swaps are not blocked', async () => {
        await pool.init({ from: owner, initialBalances });

        await expect(pool.swapGivenIn({ in: 1, out: 0, amount: fp(0.1) })).to.not.be.reverted;
      });

      it('sets token weights', async () => {
        const normalizedWeights = await pool.getNormalizedWeights();

        // Not exactly equal due to weight compression
        expect(normalizedWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
      });

      it('stores the initial weights as a zero duration weight change', async () => {
        const { startTime, endTime, endWeights } = await pool.getGradualWeightUpdateParams();

        expect(startTime).to.equal(endTime);
        expect(endWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
      });

      it('reverts if swap hook caller is not the vault', async () => {
        await expect(
          pool.instance.onSwap(
            {
              kind: SwapKind.GivenIn,
              tokenIn: poolTokens.first.address,
              tokenOut: poolTokens.second.address,
              amount: 0,
              poolId: await pool.getPoolId(),
              lastChangeBlock: 0,
              from: other.address,
              to: other.address,
              userData: '0x',
            },
            0,
            0
          )
        ).to.be.revertedWith('CALLER_NOT_VAULT');
      });
    });
  });

  describe('permissioned actions', () => {
    describe('enable/disable swaps', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      context('when the sender is not the owner', () => {
        it('non-owners cannot disable swaps', async () => {
          await expect(pool.setSwapEnabled(other, false)).to.be.revertedWith('SENDER_NOT_ALLOWED');
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender to owner', () => {
          sender = owner;
        });

        sharedBeforeEach('initialize pool', async () => {
          await pool.init({ from: sender, initialBalances });
        });

        it('cannot add to the allowlist when it is not enabled', async () => {
          await expect(pool.addAllowedAddress(sender, other.address)).to.be.revertedWith('UNAUTHORIZED_OPERATION');
        });

        it('swaps can be enabled and disabled', async () => {
          await pool.setSwapEnabled(sender, false);
          expect(await pool.instance.getSwapEnabled()).to.be.false;

          await pool.setSwapEnabled(sender, true);
          expect(await pool.instance.getSwapEnabled()).to.be.true;
        });

        it('disabling swaps emits an event', async () => {
          const receipt = await pool.setSwapEnabled(sender, false);

          expectEvent.inReceipt(await receipt.wait(), 'SwapEnabledSet', {
            swapEnabled: false,
          });
        });

        it('enabling swaps emits an event', async () => {
          const receipt = await pool.setSwapEnabled(sender, true);

          expectEvent.inReceipt(await receipt.wait(), 'SwapEnabledSet', {
            swapEnabled: true,
          });
        });

        context('with swaps disabled', () => {
          sharedBeforeEach(async () => {
            await pool.setSwapEnabled(sender, false);
          });

          context('proportional joins/exits', () => {
            it('allows proportionate joins', async () => {
              const startingBpt = await pool.balanceOf(sender);

              const { amountsIn } = await pool.joinAllGivenOut({ from: sender, bptOut: startingBpt });

              const endingBpt = await pool.balanceOf(sender);
              expect(endingBpt).to.be.gt(startingBpt);
              expect(amountsIn).to.deep.equal(initialBalances);
            });

            it('allows proportional exits', async () => {
              const previousBptBalance = await pool.balanceOf(sender);
              const bptIn = pct(previousBptBalance, 0.8);

              await expect(pool.multiExitGivenIn({ from: sender, bptIn })).to.not.be.reverted;

              const newBptBalance = await pool.balanceOf(sender);
              expect(newBptBalance).to.equalWithError(pct(previousBptBalance, 0.2), 0.001);
            });
          });

          context('disproportionate joins/exits', () => {
            it('prevents disproportionate joins (single token)', async () => {
              const bptOut = await pool.balanceOf(sender);

              await expect(pool.joinGivenOut({ from: sender, bptOut, token: poolTokens.get(0) })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });

            it('prevents disproportionate exits (single token)', async () => {
              const previousBptBalance = await pool.balanceOf(sender);
              const bptIn = pct(previousBptBalance, 0.5);

              await expect(
                pool.singleExitGivenIn({ from: sender, bptIn, token: poolTokens.get(0) })
              ).to.be.revertedWith('INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED');
            });

            it('prevents disproportionate joins (multi token)', async () => {
              const amountsIn = [...initialBalances];
              amountsIn[0] = 0;

              await expect(pool.joinGivenIn({ from: sender, amountsIn })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });

            it('prevents disproportionate exits (multi token)', async () => {
              const amountsOut = [...initialBalances];
              // Make it disproportionate (though it will fail with this exit type even if it's technically proportionate)
              amountsOut[0] = 0;

              await expect(pool.exitGivenOut({ from: sender, amountsOut })).to.be.revertedWith(
                'INVALID_JOIN_EXIT_KIND_WHILE_SWAPS_DISABLED'
              );
            });
          });
        });
      });
    });

    describe('update weights gradually', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
        };
        pool = await WeightedPool.create(params);
      });

      const UPDATE_DURATION = DAY * 2;

      context('when the sender is not the owner', () => {
        it('non-owners cannot update weights', async () => {
          const now = await currentTimestamp();

          await expect(pool.updateWeightsGradually(other, now, now, poolWeights)).to.be.revertedWith(
            'SENDER_NOT_ALLOWED'
          );
        });
      });

      context('when the sender is the owner', () => {
        beforeEach('set sender to owner', () => {
          sender = owner;
        });

        sharedBeforeEach('initialize pool', async () => {
          await pool.init({ from: sender, initialBalances });
        });

        context('with invalid parameters', () => {
          let now: BigNumber;

          sharedBeforeEach(async () => {
            now = await currentTimestamp();
          });

          it('fails if end weights are mismatched (too few)', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now, WEIGHTS.slice(0, 1))).to.be.revertedWith(
              'INPUT_LENGTH_MISMATCH'
            );
          });

          it('fails if the end weights are mismatched (too many)', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now, [...WEIGHTS, fp(0.5)])).to.be.revertedWith(
              'INPUT_LENGTH_MISMATCH'
            );
          });

          it('fails if start time > end time', async () => {
            await expect(pool.updateWeightsGradually(sender, now, now.sub(1), poolWeights)).to.be.revertedWith(
              'GRADUAL_UPDATE_TIME_TRAVEL'
            );
          });

          it('fails with an end weight below the minimum', async () => {
            const badWeights = [...poolWeights];
            badWeights[2] = fp(0.005);

            await expect(
              pool.updateWeightsGradually(sender, now.add(100), now.add(WEEK), badWeights)
            ).to.be.revertedWith('MIN_WEIGHT');
          });

          it('fails with invalid normalized end weights', async () => {
            const badWeights = Array(poolWeights.length).fill(fp(0.6));

            await expect(
              pool.updateWeightsGradually(sender, now.add(100), now.add(WEEK), badWeights)
            ).to.be.revertedWith('NORMALIZED_WEIGHT_INVARIANT');
          });

          context('with start time in the past', () => {
            let now: BigNumber, startTime: BigNumber, endTime: BigNumber;
            const endWeights = [...poolWeights];

            sharedBeforeEach('updateWeightsGradually (start time in the past)', async () => {
              now = await currentTimestamp();
              // Start an hour in the past
              startTime = now.sub(MINUTE * 60);
              endTime = now.add(UPDATE_DURATION);
            });

            it('fast-forwards start time to present', async () => {
              await pool.updateWeightsGradually(owner, startTime, endTime, endWeights);
              const updateParams = await pool.getGradualWeightUpdateParams();

              // Start time should be fast-forwarded to now
              expect(updateParams.startTime).to.equal(await currentTimestamp());
            });
          });
        });

        function itHandlesWeightUpdates(): void {
          context('with valid parameters (ongoing weight update)', () => {
            // startWeights must equal "weights" above - just not using fp to keep math simple
            const startWeights = [...poolWeights];
            const endWeights = [...poolWeights];

            // Now generate endWeights (first weight doesn't change)
            for (let i = 2; i < poolWeights.length; i++) {
              endWeights[i] = 0 == i % 2 ? startWeights[i].add(fp(0.02)) : startWeights[i].sub(fp(0.02));
            }

            function getEndWeights(pct: number): BigNumber[] {
              const intermediateWeights = Array<BigNumber>(poolWeights.length);

              for (let i = 0; i < poolWeights.length; i++) {
                if (startWeights[i] < endWeights[i]) {
                  // Weight is increasing
                  intermediateWeights[i] = startWeights[i].add(endWeights[i].sub(startWeights[i]).mul(pct).div(100));
                } else {
                  // Weight is decreasing (or not changing)
                  intermediateWeights[i] = startWeights[i].sub(startWeights[i].sub(endWeights[i]).mul(pct).div(100));
                }
              }

              return intermediateWeights;
            }

            let now, startTime: BigNumber, endTime: BigNumber;
            const START_DELAY = MINUTE * 10;
            const finalEndWeights = getEndWeights(100);

            sharedBeforeEach('updateWeightsGradually', async () => {
              now = await currentTimestamp();
              startTime = now.add(START_DELAY);
              endTime = startTime.add(UPDATE_DURATION);

              await pool.updateWeightsGradually(owner, startTime, endTime, finalEndWeights);
            });

            it('updating weights emits an event', async () => {
              const receipt = await pool.updateWeightsGradually(owner, startTime, endTime, finalEndWeights);

              expectEvent.inReceipt(await receipt.wait(), 'GradualWeightUpdateScheduled', {
                startTime: startTime,
                endTime: endTime,
                // weights don't exactly match because of the compression
              });
            });

            it('stores the params', async () => {
              const updateParams = await pool.getGradualWeightUpdateParams();

              expect(updateParams.startTime).to.equalWithError(startTime, 0.001);
              expect(updateParams.endTime).to.equalWithError(endTime, 0.001);
              expect(updateParams.endWeights).to.equalWithError(finalEndWeights, 0.001);
            });

            it('gets start weights if called before the start time', async () => {
              const normalizedWeights = await pool.getNormalizedWeights();

              // Need to decrease precision
              expect(normalizedWeights).to.equalWithError(pool.normalizedWeights, 0.0001);
            });

            it('gets end weights if called after the end time', async () => {
              await advanceTime(endTime.add(MINUTE));
              const normalizedWeights = await pool.getNormalizedWeights();

              // Need to decrease precision
              expect(normalizedWeights).to.equalWithError(finalEndWeights, 0.0001);
            });

            for (let pct = 5; pct < 100; pct += 5) {
              it(`gets correct intermediate weights if called ${pct}% through`, async () => {
                await advanceTime(START_DELAY + (UPDATE_DURATION * pct) / 100);
                const normalizedWeights = await pool.getNormalizedWeights();

                // Need to decrease precision
                expect(normalizedWeights).to.equalWithError(getEndWeights(pct), 0.005);
              });
            }
          });
        }

        itHandlesWeightUpdates();
      });
    });

    describe('protocol fee cache update', () => {
      let vault: Vault;
      const swapFeePercentage = fp(0.02);
      const managementSwapFeePercentage = fp(0.8);

      sharedBeforeEach('deploy pool', async () => {
        vault = await Vault.create();

        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
          vault,
          swapFeePercentage,
          managementSwapFeePercentage,
        };
        pool = await WeightedPool.create(params);
      });

      it('emits event when protocol fee cache is updated', async () => {
        const receipt = await pool.instance.updateCachedProtocolSwapFeePercentage();

        // Real Vault will return a zero protocol fee
        expectEvent.inReceipt(await receipt.wait(), 'ProtocolSwapFeeCacheUpdated', {
          protocolSwapFeePercentage: 0,
        });
      });
    });

    describe('BPT protocol fees', () => {
      let protocolFeesCollector: Contract;
      let vault: Vault;
      const swapFeePercentage = fp(0.02);
      const protocolFeePercentage = fp(0.5); // 50 %
      const managementSwapFeePercentage = fp(0); // Set to zero to isolate BPT fees
      const tokenAmount = 100;
      const poolWeights = [fp(0.8), fp(0.2)];
      let bptFeeBalance: BigNumber;
      let mockMath: Contract;

      let twoTokens: TokenList;
      let localBalances: Array<BigNumber>;
      let swapAmount: BigNumber;

      sharedBeforeEach('deploy pool', async () => {
        vault = await Vault.create({ admin });
        await vault.setSwapFeePercentage(protocolFeePercentage, { from: admin });
        protocolFeesCollector = await vault.getFeesCollector();

        twoTokens = poolTokens.subset(2);
        localBalances = [bn(tokenAmount * 10 ** twoTokens.first.decimals), bn(100 * 10 ** twoTokens.second.decimals)];

        // 10% of the initial balance
        swapAmount = localBalances[0].div(10);

        // Make a 2-token pool for this purpose
        const params = {
          tokens: twoTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
          vault,
          swapFeePercentage,
          managementSwapFeePercentage,
        };
        pool = await WeightedPool.create(params);
        mockMath = await deploy('MockWeightedMath');
      });

      sharedBeforeEach('initialize pool', async () => {
        await poolTokens.mint({ to: owner, amount: fp(10000) });
        await poolTokens.approve({ from: owner, to: await pool.getVault() });
        await pool.init({ from: owner, initialBalances: localBalances });
      });

      it('protocol fees are initially zero', async () => {
        bptFeeBalance = await pool.balanceOf(protocolFeesCollector.address);

        expect(bptFeeBalance).to.equal(0);
      });

      describe('pays protocol fees on swaps', () => {
        let upscaledBalances: Array<BigNumber>;
        let upscaledSwapAmount: BigNumber;

        sharedBeforeEach('upscale balances and amounts', async () => {
          const scaleFactor0 = 10 ** (18 - twoTokens.first.decimals);
          const scaleFactor1 = 10 ** (18 - twoTokens.second.decimals);
          upscaledBalances = [localBalances[0].mul(scaleFactor0), localBalances[1].mul(scaleFactor1)];
          upscaledSwapAmount = swapAmount.mul(scaleFactor0);
        });
      });
    });
  });

  describe('add token', () => {
    let vault: Vault;
    let newToken: string;
    let initialBalances: BigNumber[];
    let poolTokens: TokenList;

    const swapFeePercentage = fp(0.02);
    const managementSwapFeePercentage = fp(0.8);

    sharedBeforeEach('deploy Vault', async () => {
      vault = await Vault.create();
    });

    context('max-token pool', () => {
      sharedBeforeEach('deploy max-token pool', async () => {
        poolTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
        newToken = poolTokens.get(MAX_TOKENS).address;
        initialBalances = Array(MAX_TOKENS).fill(fp(1));
        await poolTokens.mint({ to: [owner], amount: fp(100) });
        await poolTokens.approve({ from: owner, to: vault.address });

        const params = {
          tokens: poolTokens.subset(MAX_TOKENS),
          weights: Array(MAX_TOKENS).fill(fp(1 / MAX_TOKENS)),
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
          vault,
        };
        pool = await WeightedPool.create(params);

        await pool.init({ from: owner, initialBalances });
      });

      it('prevents adding to a max-token pool', async () => {
        await expect(
          pool.addToken(owner, newToken, fp(0.01), fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
        ).to.be.revertedWith('MAX_TOKENS');
      });

      it('reverts if the vault is called directly', async () => {
        await expect(
          vault.instance.connect(owner).joinPool(await pool.getPoolId(), owner.address, other.address, {
            assets: poolTokens.subset(MAX_TOKENS).addresses,
            maxAmountsIn: new Array(MAX_TOKENS).fill(fp(1000)),
            userData: ManagedPoolEncoder.joinForAddToken(newToken, fp(100)),
            toInternalBalance: false,
          })
        ).to.be.revertedWith('UNAUTHORIZED_JOIN');
      });
    });

    describe('3-token pool', () => {
      const numPoolTokens = 3;
      const totalTokens = numPoolTokens * 2 + 1;
      // We want to be able to add at known positions, so create the pool with extra tokens:
      // 0: <token to be added at beginning>
      // 1: first pool token
      // 2: <token to be added at position 1>
      // 3: second pool token
      // 4: <token to be added at position 2>
      // 5: third pool token
      // 6: <token to be appended to the end>
      const existingTokens: Token[] = [];
      const addedTokens: Token[] = [];
      let poolWeights: BigNumber[] = [];
      let newTokenAddress: string;

      function itCanAddAToken(tokenIndex: number, normalizedWeight: BigNumber, swapsDisabled: boolean): void {
        describe('when parameters are valid', () => {
          //let weightsBefore: BigNumber[];
          const expectedWeightsAfter: Map<string, BigNumber> = new Map<string, BigNumber>();
          const expectedTokensAfter: string[] = [];
          const tokenAmountIn = fp(1);

          sharedBeforeEach('set swap state', async () => {
            if (swapsDisabled) {
              await pool.setSwapEnabled(owner, false);
            }

            newTokenAddress = addedTokens[tokenIndex].address;

            const weightsBefore = await pool.getNormalizedWeights();
            const weightSum = await pool.instance.getDenormWeightSum();
            const { tokens } = await pool.getTokens();
            const x = fromFp(weightSum).div(fromFp(fp(1).sub(normalizedWeight)));
            const weightSumAfterAdd = fp(x);

            // Expected tokens are the existing ones plus the one we're adding
            tokens.map((token) => expectedTokensAfter.push(token));
            expectedTokensAfter.push(newTokenAddress);
            expectedWeightsAfter.set(newTokenAddress, normalizedWeight); // .mul(weightSumAfterAdd).div(fp(1)
            weightsBefore.map((w, i) =>
              expectedWeightsAfter.set(tokens[i], fp(fromFp(w).div(fromFp(weightSumAfterAdd))))
            );
          });

          it('calculates bptAmountOut', async () => {
            await pool.instance
              .connect(owner)
              .checkAddTokenBptAmount(
                addedTokens[tokenIndex].address,
                normalizedWeight,
                fp(1),
                ZERO_ADDRESS,
                0,
                owner.address,
                other.address
              );
          });

          context('when token is added', () => {
            sharedBeforeEach('add token', async () => {
              const tx = await pool.addToken(
                owner,
                newTokenAddress,
                normalizedWeight,
                tokenAmountIn,
                ZERO_ADDRESS,
                0,
                owner.address,
                other.address
              );
              const receipt = await tx.wait();
              expectEvent.inReceipt(receipt, 'TokenAdded', {
                token: newTokenAddress,
                weight: normalizedWeight,
                initialBalance: tokenAmountIn,
              });
            });

            it(`adds token at ${tokenIndex} at ${fromFp(normalizedWeight).toFixed(
              2
            )}, with swapDisabled=${swapsDisabled}`, async () => {
              const { assetManager } = await vault.getPoolTokenInfo(await pool.getPoolId(), addedTokens[tokenIndex]);

              // Has no asset manager
              expect(assetManager).to.equal(ZERO_ADDRESS);
              expect(await pool.instance.getTotalTokens()).to.equal(numPoolTokens + 1);
            });

            it('inserts the token', async () => {
              const { tokens } = await pool.getTokens();

              expect(tokens).to.have.members(expectedTokensAfter);
            });

            it('rebalances weights', async () => {
              const { tokens } = await pool.getTokens();
              const finalWeights = await pool.getNormalizedWeights();

              tokens.forEach((token, i) => {
                const weightAfter = expectedWeightsAfter.get(token) || 0;
                expect(finalWeights[i]).to.equalWithError(weightAfter, 0.0000001);
              });
            });

            it('transfers initial balance of new token', async () => {
              const { balances } = await pool.getTokens();

              expect(balances[tokenIndex]).to.equal(tokenAmountIn);
            });
          });
        });
      }

      sharedBeforeEach('deploy pool', async () => {
        allTokens = await TokenList.create(totalTokens, { sorted: true, varyDecimals: true });
        let j = 0;
        let i;
        for (i = 1; i < totalTokens; i += 2) {
          existingTokens[j++] = allTokens.get(i);
        }

        j = 0;
        for (i = 0; i < totalTokens; i += 2) {
          addedTokens[j++] = allTokens.get(i);
        }

        initialBalances = Array(numPoolTokens).fill(fp(1));
        poolTokens = new TokenList(existingTokens);
        poolWeights = toNormalizedWeights(
          Array(numPoolTokens)
            .fill(fp(1 / numPoolTokens))
            .map(bn)
        );

        const params = {
          tokens: poolTokens,
          weights: poolWeights,
          owner: owner.address,
          poolType: WeightedPoolType.MANAGED_POOL,
          swapEnabledOnStart: true,
          swapFeePercentage: swapFeePercentage,
          managementSwapFeePercentage: managementSwapFeePercentage,
          vault,
        };
        pool = await WeightedPool.create(params);
      });

      sharedBeforeEach('initialize pool', async () => {
        await allTokens.mint({ to: [owner], amount: fp(100) });
        await allTokens.approve({ from: owner, to: vault.address });
        await allTokens.approve({ from: owner, to: pool.address });

        await pool.init({ from: owner, initialBalances });
      });
    });

      context('when parameters are invalid', () => {
        it('when the normalized weight is invalid', async () => {
          newTokenAddress = addedTokens[0].address;

          const weightTooLow = fp(0.005);
          const weightTooHigh = fp(1);

          await expect(
            pool.addToken(owner, newTokenAddress, weightTooLow, fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
          ).to.be.revertedWith('MIN_WEIGHT');
          await expect(
            pool.addToken(owner, newTokenAddress, weightTooHigh, fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
          ).to.be.revertedWith('MAX_WEIGHT');
        });

        it('where there is an ongoing weight change', async () => {
          const startTime = await currentTimestamp();
          const endTime = startTime.add(DAY * 3);

          await pool.updateWeightsGradually(owner, startTime, endTime, poolWeights);
          await advanceTime(DAY);

          await expect(
            pool.addToken(owner, newTokenAddress, fp(0.1), fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
          ).to.be.revertedWith('CHANGE_TOKENS_DURING_WEIGHT_CHANGE');
        });

        it('when there is a pending weight change', async () => {
          const startTime = await currentTimestamp();
          const endTime = startTime.add(DAY * 3);

          await pool.updateWeightsGradually(owner, startTime.add(DAY), endTime, poolWeights);

          await expect(
            pool.addToken(owner, newTokenAddress, fp(0.1), fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
          ).to.be.revertedWith('CHANGE_TOKENS_PENDING_WEIGHT_CHANGE');
        });

        it('when the incoming weight is too high', async () => {
          await expect(
            pool.addToken(owner, newTokenAddress, fp(0.98), fp(1), ZERO_ADDRESS, 0, owner.address, other.address)
          ).to.be.revertedWith('MIN_WEIGHT');
        });

        it('when the bptPrice is too low', async () => {
          await expect(
            pool.addToken(owner, newTokenAddress, fp(0.1), fp(1), ZERO_ADDRESS, fp(10000), owner.address, other.address)
          ).to.be.revertedWith('MIN_BPT_PRICE_ADD_TOKEN');
        });

        it('when the token is already in the pool', async () => {
          await expect(
            pool.addToken(
              owner,
              poolTokens.get(0).address,
              fp(0.1),
              fp(1),
              ZERO_ADDRESS,
              0,
              owner.address,
              other.address
            )
          ).to.be.revertedWith('TOKEN_ALREADY_REGISTERED');
        });
      });

      // Try it once with swaps disabled (don't need to do all permutations)
      itCanAddAToken(0, fp(0.1), true);

      for (let i = 0; i < numPoolTokens + 1; i++) {
        //for (let w = 0.01; w < 0.7; w += 0.09) {
        itCanAddAToken(i, fp(0.2), false);
        //}
      }

      context('with an asset manager', () => {
        it('registers a token with an asset manager', async () => {
          await pool.addToken(
            owner,
            addedTokens[0].address,
            fp(0.1),
            fp(1),
            mockAssetManager.address,
            0,
            owner.address,
            other.address
          );

          const { assetManager } = await vault.getPoolTokenInfo(await pool.getPoolId(), addedTokens[0]);

          expect(assetManager).to.equal(mockAssetManager.address);
        });
      });
    });
  });
});
