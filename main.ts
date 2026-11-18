// Deep-dip swing bot for the make.fun btc-race-24h-20261118-1444 competition.
// Strategy: buy tranches of $300 only after a sharp 30-minute fall, then let
// each tranche ride the bounce and exit on a trailing stop. No dip-buying in
// chop, no chasing strength, no holding through the end of the window.
//
// Why this shape: on the dev window (1,440 one-minute cbBTC bars, -2.79% with
// 1-min return stdev 6.67 bps) the money sits in a handful of V-shaped swings
// of 80-200 bps over 10-115 bars. A tight grid bleeds its edge to the ~13 bps
// round-trip cost (4 bps fee + 2 bps slippage per leg, plus pool impact), and
// buying every small dip catches falling knives. Waiting for a genuine
// capitulation dip (30-bar return at or below -85 bps) and then trailing out
// of the bounce is what clears the cost with room to spare.
//
// Rules, all in basis points against integer raw prices (no floats anywhere):
//  - Entry: 30-bar close-to-close return <= -85 bps. First tranche then, and
//    while tranches are held, one more tranche each time the price falls a
//    further 25 bps below the last buy fill (a ladder that averages down into
//    the dip). At most 3 tranches of $300, at most 1 buy per bar, only with
//    cash on hand (sell proceeds of the same reply never fund a buy).
//  - Exit, per tranche: sell when the tranche's peak profit reaches 30 bps
//    and the price then retraces 20 bps from that peak (trailing stop), or
//    immediately at +120 bps (hard take-profit). In the last 90 bars, stop
//    buying and sell any tranche already 20 bps in profit.
//  - Deterministic: every decision is a pure function of the bars and fills
//    received; no clock, no environment, no randomness.
//
// Protocol: agent-fun/bars-replay/v1 via the vendored kit shim (vendor/).
// Orders decided on bar t fill at bar t+1's open, so the buy fill lands a
// bar after the signal; the trailing peak is tracked on closes, which is
// what the next open is anchored to (median next-open/close gap: ~2 bps).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// One tranche: $300 = 300,000,000 micro-USDC (quote scale 6).
const LOT_QUOTE_UNITS = 300_000_000n;
const MAX_LOTS = 3;
// Entry: 30-bar return at or below -85 bps.
const LOOKBACK_BARS = 30;
const ENTRY_BPS = -85;
// Ladder: next tranche when price is 25 bps below the last buy fill.
const STEP_BPS = 25;
// Trailing exit: arm at +30 bps peak profit, sell on a 20 bps retrace.
const ARM_BPS = 30;
const TRAIL_BPS = 20;
// Hard take-profit at +120 bps.
const HARD_TP_BPS = 120;
// Endgame: no new buys in the last 90 bars; sell tranches at +20 bps there.
const TOTAL_BARS = 1440;
const END_STOP_BARS = 90;
const END_TP_BPS = 20;
// Fills land at the next bar's open; the open/close gap is ~2 bps (max 19),
// so a 100 bps slippage cap never binds in practice but guards the fills.
const MAX_SLIPPAGE_BPS = 100;

interface Lot {
  qty: bigint;
  buyPx: bigint;
  peakPx: bigint;
  age: number;
}

type Pending =
  | { kind: 'buy'; notional: bigint }
  | { kind: 'sell'; lot: Lot };

// (a - b) / b in basis points, truncated toward zero, on raw price integers.
function bpsDiff(a: bigint, b: bigint): bigint {
  return ((a - b) * 10000n) / b;
}

// ---------------------------------------------------------------- state

const closes: bigint[] = [];
const lots: Lot[] = [];
const pending = new Map<string, Pending>();
let lastBuyPx: bigint | null = null;

function positionQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];

  // 1) Resolve the orders decided on the previous bar from this batch's fills.
  for (const fill of batch.fills) {
    const p = pending.get(fill.client_id);
    if (p === undefined) continue;
    pending.delete(fill.client_id);
    if (fill.status !== 'filled') continue;
    if (p.kind === 'buy') {
      const lot: Lot = {
        qty: BigInt(fill.qty),
        buyPx: BigInt(fill.price),
        peakPx: BigInt(fill.price),
        age: 0,
      };
      lots.push(lot);
      lastBuyPx = lot.buyPx;
    } else {
      const idx = lots.indexOf(p.lot);
      if (idx >= 0) lots.splice(idx, 1);
    }
  }

  // 2) Fold in this bar's close and age the tranches.
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  closes.push(close);
  for (const lot of lots) {
    if (close > lot.peakPx) lot.peakPx = close;
    lot.age += 1;
  }

  // Safety net: if the account says we hold something our lot book lost
  // (a fill we failed to match), track it as one lot at the current close so
  // the trailing exit can still sell it instead of stranding it to flatten.
  const held = positionQty(state);
  const booked = lots.reduce((s, l) => s + l.qty, 0n);
  if (held > 0n && booked === 0n) {
    lots.push({ qty: held, buyPx: close, peakPx: close, age: 0 });
  } else if (held === 0n && booked > 0n) {
    lots.length = 0;
  }

  const orders: OrderInput[] = [];
  const endgame = state.seq >= TOTAL_BARS - END_STOP_BARS;

  // 3) Exits, one sell order per tranche that trips.
  const selling = new Set<Lot>();
  for (const lot of [...lots]) {
    const profit = bpsDiff(close, lot.buyPx);
    const peakProfit = bpsDiff(lot.peakPx, lot.buyPx);
    const retrace = bpsDiff(lot.peakPx, close);
    const exit =
      profit >= BigInt(HARD_TP_BPS) ||
      (peakProfit >= BigInt(ARM_BPS) && retrace >= BigInt(TRAIL_BPS)) ||
      (endgame && profit >= BigInt(END_TP_BPS));
    if (!exit) continue;
    const clientId = state.clientId();
    orders.push({
      side: 'sell',
      symbol: SYMBOL,
      qty: lot.qty,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
      client_id: clientId,
    });
    pending.set(clientId, { kind: 'sell', lot });
    selling.add(lot);
  }
  const lotsAfter = lots.length - selling.size;

  // 4) Entry: one $300 tranche, only on a deep 30-bar dip (or, while
  // tranches are held, a further 25 bps ladder step below the last buy).
  if (!endgame && lotsAfter < MAX_LOTS && state.cash >= LOT_QUOTE_UNITS) {
    let want = false;
    if (closes.length > 1) {
      // 30-bar return, measured against the earliest close we hold while
      // the window is still young (mirrors the lookback exactly).
      const ref = closes[Math.max(0, closes.length - 1 - LOOKBACK_BARS)];
      const r30 = bpsDiff(close, ref);
      if (r30 <= BigInt(ENTRY_BPS)) want = true;
    }
    if (lots.length > 0 && lastBuyPx !== null) {
      // Relaxed ladder: while holding, the step below the last buy is
      // enough — the dip that started the episode is still the entry.
      want = true;
    }
    if (want && lots.length > 0 && lastBuyPx !== null) {
      if (bpsDiff(lastBuyPx, close) < BigInt(STEP_BPS)) want = false;
    }
    if (want) {
      const clientId = state.clientId();
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: LOT_QUOTE_UNITS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: clientId,
      });
      pending.set(clientId, { kind: 'buy', notional: LOT_QUOTE_UNITS });
    }
  }

  return orders;
}

await runBars({ onBatch });
