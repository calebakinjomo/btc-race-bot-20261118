# Deep-Dip Swing Bot — btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/calebakinjomo/btc-race-bot-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/calebakinjomo/btc-race-bot-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A bot that races Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars for the make.fun competition
**btc-race-24h-20261118-1444** — "Race a BTC trading bot live for 24 hours"
($250 pot, $1,000 paper money, long only, no leverage).

## Strategy

A deep-dip swing bot, not a grid and not a dip-buyer that holds forever:

- **Entry — only after a genuine capitulation dip.** A tranche of $300 is
  bought only when the 30-bar close-to-close return is at or below −85 bps.
  While tranches are held, one more tranche is added each time the price
  falls a further 25 bps below the last buy fill (a ladder that averages
  down into the dip). At most 3 tranches, at most 1 buy per bar, only with
  cash on hand.
- **Exit — trail the bounce, don't cap it.** Each tranche sells when its
  peak profit reaches +30 bps and the price then retraces 20 bps from that
  peak, or immediately at +120 bps. In the last 90 bars no new buys are
  placed and any tranche already +20 bps in profit is sold.
- **Why this shape.** The dev window falls −2.79% with 1-minute returns of
  only 6.67 bps stdev, so the money sits in a handful of V-shaped swings of
  80–200 bps over 10–115 bars. A tight grid bleeds its edge to the ~13 bps
  round-trip cost (4 bps fee + 2 bps slippage per leg, plus pool impact),
  and buying every small dip catches falling knives. Waiting for a real dip
  and trailing out of the bounce is what clears the cost with room to spare.

## Dev grade (local, kit harness, process driver)

| Metric | Value |
| --- | --- |
| Net PnL | **+$11.34** |
| Trades | 14 (7 buys / 7 sells, 100% win rate) |
| Max drawdown | 0.66% |
| Fees | $1.68 (net PnL at 2× fees: +$9.65) |
| Rejected orders | 0 |
| Determinism | L1 regrade reproduced byte for byte |
| Guardrails | met (≥1 trade, drawdown ≤ 25%) |

Every one of the 7 round trips was profitable; nothing was left to the
end-of-window flatten. The bot is deliberately quiet — it sat in cash for
the back half of the window rather than force trades in chop.

## How it works

`main.ts` (Node 22, erasable TypeScript, standard library only) speaks
`agent-fun/bars-replay/v1` through the vendored kit shim in `vendor/`.
All decisions are integer basis-point math on raw prices — no floats, no
clock, no environment, no randomness — so two runs on the same data produce
byte-identical action logs. Per-tranche state (buy price, peak price, age)
is rebuilt from the fills each batch reports, so the bot always agrees with
the harness's own books.

## Run

Grade it on the dev window with the kit CLI (from the unpacked kit dir):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, byte-for-byte
- `README.md`, `LICENSE` (MIT), `.makefun/owner.json`

---

<sub>Entered on [make.fun](https://make.fun/?ref=hdavhdvz&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
