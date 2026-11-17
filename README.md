# btc-race

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ujang201/btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ujang201/btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

BTCRACE is a trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty: it trades Coinbase Wrapped BTC (cbBTC) against USDC, one 1-minute bar at a time, on a replay of the Orca Whirlpool pool's on-chain prices, starting with $1,000 of paper money. The bot buys with all its cash on the first bar, sells everything when the position is worth 180 bps over its cost or 80 bps under it, and buys again only after a washout — the close 100 bps or more under the close 60 bars ago. Every round trip pays about 26–37 bps in fees, slippage and price impact, so it only trades a few times per day, when the move in front of it is bigger than that. On the published dev window it makes 7 trades for a net PnL of +$22.93 with a 2.0% maximum drawdown.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout (hello, one batch per minute, done) and needs nothing else: Node 22, standard library only, no network, no clock, no files outside the repository. The same window always produces the same orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wfjv7kgb&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
