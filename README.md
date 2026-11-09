# Dip Duck ($DIPDUCK) — smart contracts

Dip Duck is a meme token: the duck that stays calm when the chart turns red. This
repository holds its smart contracts, tests and deployment scripts, so anyone can read
what is running on-chain and check it.

**Official website:** [dipduck.xyz](https://dipduck.xyz) — the only source for the
contract address. Never trust an address sent in a DM.

> Network: Robinhood Chain (chain ID 4663), used as technical information only.
> Dip Duck is not affiliated with, endorsed by, or sponsored by Robinhood.
> Dip Duck is a meme collectible with no promises: no roadmap funded by sales, no yield,
> no expected profit. Do your own research.

---

## Deployed contracts (Robinhood Chain mainnet)

| Contract | Address | Source |
| --- | --- | --- |
| Token — `MemeToken` (DIPDUCK) | [`0x36384B0e1BE39EAaf2Ac36BdC53DF5123566139C`](https://robinhoodchain.blockscout.com/address/0x36384B0e1BE39EAaf2Ac36BdC53DF5123566139C?tab=contract) | [`contracts/MemeToken.sol`](contracts/MemeToken.sol) |
| Launcher — `LaunchPool` (holds the liquidity) | [`0xbDd74deFe1D289Af77ED1E41cc5b05661ABE36F2`](https://robinhoodchain.blockscout.com/address/0xbDd74deFe1D289Af77ED1E41cc5b05661ABE36F2?tab=contract) | [`contracts/LaunchPool.sol`](contracts/LaunchPool.sol) |
| Team vesting — `TokenVesting` | [`0x2C9f048336dD03B66aD3e8bCA4e84c3C3aC7bbB6`](https://robinhoodchain.blockscout.com/address/0x2C9f048336dD03B66aD3e8bCA4e84c3C3aC7bbB6?tab=contract) | [`contracts/TokenVesting.sol`](contracts/TokenVesting.sol) |
| Uniswap v3 pool DIPDUCK/WETH (1 %) | [`0x39966Ec48D8B7022827E59f740E575e50b470bc3`](https://robinhoodchain.blockscout.com/address/0x39966Ec48D8B7022827E59f740E575e50b470bc3) | Uniswap v3 |
| Community Safe (2-of-3) | [`0x14aaC4b3072022142a2Fd597ED29FDC7bF602CFF`](https://robinhoodchain.blockscout.com/address/0x14aaC4b3072022142a2Fd597ED29FDC7bF602CFF) | Safe |
| Team Safe (2-of-3) | [`0x64bAC8D0b36C3c4c0749904ac1b9fF2508cb4002`](https://robinhoodchain.blockscout.com/address/0x64bAC8D0b36C3c4c0749904ac1b9fF2508cb4002) | Safe |
| Deployer wallet (holds no tokens) | [`0xf919a3f0ae458b899fde8Fc14196425fBB887060`](https://robinhoodchain.blockscout.com/address/0xf919a3f0ae458b899fde8Fc14196425fBB887060) | — |

All three contracts are verified with an exact match on
[Blockscout](https://robinhoodchain.blockscout.com) and on
[Sourcify](https://repo.sourcify.dev/4663/0x36384B0e1BE39EAaf2Ac36BdC53DF5123566139C).
Deployment details (transactions, blocks, parameters): [`deployments/robinhood.json`](deployments/robinhood.json).

**Trading opens on Wednesday, November 11, 2026 at 7 PM ET (2026-11-12 00:00 UTC).**
Before that, the token itself refuses every trade.

---

## Tokenomics

| | Amount | Where it is |
| --- | --- | --- |
| Total supply | 1,000,000,000 DIPDUCK (fixed, 18 decimals) | minted once, at creation |
| Liquidity pool | ≈ 870,000,000 (87 %) | Uniswap v3 position owned by the launcher, forever |
| Team share | 100,000,000 (10 %) | vesting contract: nothing before a 90-day cliff, fully released after 900 days |
| Community reserve | 30,000,000 (3 %) | community Safe (meme contests, rewards) |
| Deployer wallet | 0 | — |

The pool was filled **one-sided** (tokens only, no ETH added by the team), from a starting
market cap of about 2.96 ETH. Every buy raises the price; buyers' ETH stays in the pool.

---

## What the contracts guarantee

**Token (`MemeToken`)**
- Fixed supply, minted once. No `mint`, no owner, no admin function.
- No tax, no pause, no blacklist. Does not accept ETH.
- Anti-bot rules written in the code: no trading before the opening time; then, for 24 hours,
  one wallet cannot hold more than 0.5 % of the supply (first hour), 1 % (until 6 h),
  2 % (until 24 h). After that, no limit at all.

**Launcher (`LaunchPool`)**
- Creates the token, the pool and the liquidity position in one transaction.
- Keeps the Uniswap position NFT **forever**: there is no function to withdraw, reduce or
  transfer the liquidity.
- The only thing that can leave is the 1 % trading fee, through `collectFees`, callable by
  anyone: 60 % to the community Safe, 40 % to the team Safe, fixed at deployment.
- No owner, nothing can be changed.

**Vesting (`TokenVesting`)** — OpenZeppelin `VestingWalletCliff` 5.6.1
- Schedule starts at the opening: cliff on February 9, 2027, end on April 29, 2029.
- Anyone can trigger `release`, but tokens always go to the beneficiary.
- `renounceOwnership` is disabled so the share can never be locked away by mistake.

---

## Check it yourself

1. Open each contract above on Blockscout → **Contract** tab: green check, source code.
2. Token → **Read contract**: no `owner`, `totalSupply` = 1,000,000,000.
3. Pool position: the Uniswap position NFT is owned by the launcher.
4. Vesting → **Tokens** tab: 100,000,000 DIPDUCK.
5. Deployer wallet → **Tokens** tab: 0 DIPDUCK.

The website section [“Check it yourself”](https://dipduck.xyz) links to each of these pages.

---

## Other contracts in this repository

Not deployed yet; each will be listed above once it is.

- `contracts/DipDuckCards.sol` — Dip Duck Cards, an ERC-721 collectible (3,333 cards).
  Mint fees never go to the token pool. No value, no rights, no promises.
- `contracts/DipDuckGame.sol` — on-chain “Catch the Dip” game, using Chainlink BTC/USD
  daily closes. No owner, no ETH, no prize of value.

---

## Development

Requirements: Node.js 22+.

```bash
npm install
npm test             # Solidity unit + fuzz tests, and full launch tests against real Uniswap v3 bytecode
npm run rehearsal    # full launch on a local fork of the mainnet (nothing is sent)
```

Compiler: solc 0.8.34, optimizer 200 runs, EVM `cancun`. Dependencies: OpenZeppelin
Contracts 5.6.1, Uniswap v3.

## Security

There has been no paid external audit. The code is short, immutable and tested; please
report any issue privately to [x.com/DipDuckToken](https://x.com/DipDuckToken) (DM open for security reports only).

## License

MIT
