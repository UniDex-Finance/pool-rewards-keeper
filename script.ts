import axios from "axios";
import { ethers } from "ethers";
require("dotenv").config();

const GRAPHQL_API_URL = process.env.GRAPHQL_API_URL!;
const CONTRACT_ADDRESS = process.env.POOL_ADDRESS!;
const DISPERSE_CONTRACT_ADDRESS = process.env.DISPERSE_CONTRACT_ADDRESS!;
const PROVIDER_URL = process.env.PROVIDER_URL!;
const TOTAL_REWARD = process.env.TOTAL_REWARD!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const POOL_CURRENCY = process.env.POOL_CURRENCY!;

const contractABI = [
  "function getCurrencyBalance(address) view returns (uint256)",
];
const disperseContractABI = [
  {
    constant: false,
    inputs: [
      { name: "recipients", type: "address[]" },
      { name: "values", type: "uint256[]" },
    ],
    name: "disperseEther",
    outputs: [],
    payable: true,
    stateMutability: "payable",
    type: "function",
  },
];

const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);
const disperseContract = new ethers.Contract(
  DISPERSE_CONTRACT_ADDRESS,
  disperseContractABI,
  provider
);

interface Deposit {
  user: string;
}
interface UserStakes {
  [user: string]: {
    stake: ethers.BigNumber;
    rewardShare: string;
  };
}
async function fetchUniqueDepositors(): Promise<string[]> {
  const query = `
        query MyQuery {
            Deposits(filter: {currency: "${POOL_CURRENCY}"}) {
                user
            }
        }
    `;

  try {
    const response = await axios.post(GRAPHQL_API_URL, { query });
    const deposits: Deposit[] = response.data.data.Deposits;
    return Array.from(new Set(deposits.map((deposit) => deposit.user)));
  } catch (error) {
    console.error("Error fetching unique depositors:", error);
    return [];
  }
}

async function fetchActualDeposits() {
  const uniqueDepositors = await fetchUniqueDepositors();
  let totalStaked = ethers.BigNumber.from(0);

  const userStakes: {
    [user: string]: { stake: ethers.BigNumber; rewardShare: string };
  } = {};

  for (const user of uniqueDepositors) {
    try {
      const actualBalance = await contract.getCurrencyBalance(user);
      totalStaked = totalStaked.add(actualBalance);
      userStakes[user] = { stake: actualBalance, rewardShare: "" };
    } catch (error) {
      console.error(`Error fetching balance for ${user}:`, error);
    }
  }

  // Calculate reward share for each user
  for (const user in userStakes) {
    if (!userStakes[user].stake.isZero()) {
      const totalRewardBigNumber = ethers.utils.parseEther(
        TOTAL_REWARD.toString()
      );
      const rewardShareBigNumber = userStakes[user].stake
        .mul(totalRewardBigNumber)
        .div(totalStaked);
      userStakes[user].rewardShare =
        ethers.utils.formatEther(rewardShareBigNumber);
    }
  }

  // Print user stakes and reward shares
  for (const user in userStakes) {
    if (userStakes[user].stake.isZero()) {
      continue; // Skip to the next iteration if the stake is zero
    }
    console.log(
      `User: ${user}, Stake: ${ethers.utils.formatUnits(
        userStakes[user].stake,
        18
      )}, Reward Share: ${userStakes[user].rewardShare}`
    );
  }

  // Proceed to disperse rewards
  await disperseRewards(userStakes);
}

async function disperseRewards(userStakes: UserStakes) {
  const recipients: string[] = [];
  const values: ethers.BigNumber[] = [];

  for (const user in userStakes) {
    if (!userStakes[user].stake.isZero()) {
      recipients.push(user);
      const rewardShareWei = ethers.utils.parseEther(
        userStakes[user].rewardShare
      );
      values.push(rewardShareWei);
    }
  }

  // Ensure the connected account has enough Ether to disperse
  const tx = await disperseContract
    .connect(signer)
    .disperseEther(recipients, values, {
      value: ethers.utils.parseEther(TOTAL_REWARD.toString()),
    });

  console.log("Disperse transaction sent:", tx.hash);
  await tx.wait();
  console.log("Disperse transaction confirmed:", tx.hash);
  
}

fetchActualDeposits();
