// Hardhat in-process fork node, used for fork tests when anvil is not installed.
// FORK_URL / FORK_CHAIN_ID come from the test harness (test/fork/forkNode.ts).
const chainId = Number(process.env.FORK_CHAIN_ID || 1);
module.exports = {
  networks: {
    hardhat: {
      chainId,
      forking: { url: process.env.FORK_URL },
      // chains Hardhat does not know need a hardfork history to execute historical blocks
      chains: { [chainId]: { hardforkHistory: { cancun: 0 } } },
      hardfork: "cancun",
      mining: { auto: true },
      accounts: { count: 2 },
    },
  },
};
