// BTCRACE — a cbBTC trading bot for make.fun's "Race a BTC trading bot live
// for 24 hours" bounty (btc-race-24h-20261117-0603).
//
// The bot speaks agent-fun/bars-replay/v1 over stdin/stdout: the harness sends
// one `hello` line, then one `batch` per minute of the window, then `done`.
// Every batch carries the bar that just closed, the fills of the orders sent
// on the previous batch, and the account. The bot answers every batch with
// exactly one `reply` echoing its seq, carrying at most 16 orders. An order
// decided on the batch of the bar closing at minute t fills at the open of
// the next bar. The replay is long only, starts with 1,000 USDC of paper
// money, charges 4 bps of fee plus 2 bps of modelled slippage per fill, and
// adds the order's own price impact against the bar's open pool depth.
//
// This file is the entrypoint the grader runs as `node /bot/main.ts` (Node 22,
// type stripping: erasable syntax only, standard library only). It keeps no
// state on disk, reads no clock and no environment: every decision comes from
// the bars and the account the harness sends, so the same window always
// produces the same orders.
//
// Strategy (v2): a mean-reversion rider with a profit cap.
//
//   - Buy with all cash on the first batch: the window starts flat, so the
//     bot is in the market from the open and always makes at least one trade.
//   - While holding, sell everything when the position is worth 180 bps over
//     its cost (take profit: a full-size round trip pays about 26-37 bps in
//     fees, slippage and impact, so 180 bps locks a real gain) or 80 bps
//     under it (stop loss: cut a slide before it becomes a drawdown). The
//     cost is the one the harness reports for the position, which is the
//     full notional of the buy including its fee.
//   - While flat, buy again only after a washout: the close 100 bps or more
//     under the close 60 bars ago. Sharp one-hour drops in BTC tend to bounce
//     at least part-way back, and the 150/100 exit pair pays about 2:1 when
//     they do; when they do not, the stop loss caps the damage.
//   - Nothing else trades. On the choppy dev window this makes a handful of
//     trades instead of dozens, so fees do not eat the edge.

import { createInterface } from "node:readline";

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 100;

interface Hello {
  seed: string;
  symbols: { symbol: string; price_scale: number; qty_scale: number }[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
  first_close_ms: number;
}

interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface Batch {
  type: string;
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: {
    cash_quote_units: string;
    positions: Position[];
    equity_quote_units: string;
  };
}

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

let hello: Hello | null = null;
let warmupBars = 0;
let orderCounter = 0;
/** Closes seen so far, as numbers, oldest first. */
const closes: number[] = [];
/** Take profit, in bps over the position's cost. */
const TAKE_PROFIT_BPS = 180n;
/** Stop loss, in bps under the position's cost. */
const STOP_LOSS_BPS = 80n;
/** Washout window, in bars, and its depth, in bps, for re-entry. */
const DIP_BARS = 60;
const DIP_BPS = 100;

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return `${prefix}${orderCounter}`;
}

/**
 * The value of a position at a close, in quote units: qty * close, rescaled
 * from (qty_scale, price_scale) to quote_scale. All integer math.
 */
function positionValue(qty: string, close: string): bigint {
  if (hello === null) return 0n;
  const sym = hello.symbols[0];
  const num =
    BigInt(qty) * BigInt(close) * 10n ** BigInt(hello.capital.quote_scale);
  const den = 10n ** BigInt(sym.qty_scale + sym.price_scale);
  return num / den;
}

/** Decide the orders for one batch. */
function decide(batch: Batch): Order[] {
  if (hello === null) return [];
  if (batch.seq < warmupBars) return [];
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const held = batch.account.positions.find((p) => p.symbol === SYMBOL);
  if (held !== undefined) {
    // Holding: exit on take profit or stop loss, measured on the cost the
    // harness reports for the position, not on the price we decided at.
    const cost = BigInt(held.cost_quote_units);
    const value = positionValue(held.qty, bar.c);
    if (
      value * 10000n >= cost * (10000n + TAKE_PROFIT_BPS) ||
      value * 10000n <= cost * (10000n - STOP_LOSS_BPS)
    ) {
      return [
        {
          side: "sell",
          client_id: nextClientId("s"),
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }
  // Flat: buy at the open, or after a washout dip.
  const cash = BigInt(batch.account.cash_quote_units);
  const minNotional = BigInt(hello.fees.min_notional_quote_units);
  if (cash < minNotional) return [];
  const firstBatch = closes.length <= 1;
  let dip = false;
  if (closes.length > DIP_BARS) {
    const then = closes[closes.length - 1 - DIP_BARS];
    const now = closes[closes.length - 1];
    dip = (now - then) / then <= -DIP_BPS / 10000;
  }
  if (firstBatch || dip) {
    return [
      {
        side: "buy",
        client_id: nextClientId("b"),
        symbol: SYMBOL,
        notional_quote_units: cash.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type: string; seq?: number };
    if (msg.type === "hello") {
      hello = msg as unknown as Hello;
      warmupBars = hello.warmup_bars ?? 0;
      continue;
    }
    if (msg.type === "batch") {
      const batch = msg as unknown as Batch;
      const bar = batch.bars.find((b) => b.symbol === SYMBOL);
      if (bar !== undefined) closes.push(Number(bar.c));
      const orders = decide(batch);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
      );
      continue;
    }
    if (msg.type === "done") {
      break;
    }
    // Any other message type is a protocol violation by the harness, not us;
    // there is nothing sensible to answer, so stop rather than guessing.
    throw new Error(`unknown message type: ${msg.type}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`btcrace: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
