import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  dayOfSeason,
  DAYS_PER_SEASON,
  hourOfDay,
  seasonForTick,
  sleepQuality,
  sleepRoll,
  TICKS_PER_DAY,
  TICKS_PER_SEASON,
  timeLabel,
  type Season,
} from "../orchestrator/src/perception.js";
import { ALL_ITEMS } from "../orchestrator/src/policy-agents.js";

type SeasonBps = readonly [number, number, number, number];

interface IdVector {
  tick: number;
  seq: number;
  id: number;
}

interface ExpiryVector {
  tick: number;
  expires_at: number;
}

interface MeanVector {
  prices: number[];
  mean: number | null;
}

interface RingVector {
  pushes: number[];
  ring: number[];
  mean: number;
}

interface SeasonRow {
  item: string;
  bps: SeasonBps;
}

interface SleepRollVector {
  tick: number;
  agent_index: number;
  roll: number;
}

interface SleepQualityVector {
  roll: number;
  sickness: number;
  quality: number;
}

interface CalendarVector {
  tick: number;
  season: Season;
  day: number;
  hour: number;
  label: string;
}

interface Vectors {
  constants: {
    id_shift: number;
    order_ttl: number;
    price_ring_cap: number;
    ticks_per_day: number;
    days_per_season: number;
    ticks_per_season: number;
  };
  ids: {
    order: IdVector[];
    fill: IdVector[];
  };
  expires_at: ExpiryVector[];
  mean_price: MeanVector[];
  price_ring: RingVector[];
  season_bps: {
    default: number;
    items: SeasonRow[];
  };
  sleep: {
    rolls: SleepRollVector[];
    qualities: SleepQualityVector[];
  };
  calendar: CalendarVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/primitives.json", import.meta.url), "utf8"),
) as Vectors;

const ID_SHIFT = 20;
const ORDER_TTL = 16;
const PRICE_RING_CAP = 10;
const SEQUENCE_LIMIT = 2 ** ID_SHIFT;

// contracts/world/src/market.rs keeps the last ten prices per item.
const SEASON_BPS: Readonly<Record<string, SeasonBps>> = {
  wheat: [1200, 1500, 1000, 0],
  flour: [1000, 1000, 1000, 1000],
  bread: [1000, 1000, 1000, 1000],
  meat: [1000, 1000, 1200, 800],
  milk: [1200, 1000, 800, 600],
  eggs: [1500, 1000, 800, 500],
  vegetables: [1200, 1500, 1000, 0],
  herbs: [1500, 1200, 800, 0],
  medicine: [1000, 1000, 1000, 1000],
  iron_ore: [1000, 1000, 1000, 800],
  coal: [1000, 1000, 1000, 1200],
  iron_tools: [1000, 1000, 1000, 1000],
  timber: [1000, 1000, 1200, 800],
  firewood: [800, 800, 1200, 1500],
  furniture: [1000, 1000, 1000, 1000],
  ale: [1000, 1200, 1500, 1000],
  meal: [1000, 1000, 1000, 1000],
  cloth: [1000, 1000, 1000, 1200],
};

const DEFAULT_SEASON_BPS: SeasonBps = [1000, 1000, 1000, 1000];

// Rust: (tick << 20) | seq, with seq < 2^20. Number arithmetic avoids
// JavaScript's 32-bit bitwise truncation for large ticks.
function scopedId(tick: number, seq: number): number {
  return tick * SEQUENCE_LIMIT + seq;
}

function meanPrice(prices: readonly number[]): number | null {
  const count = prices.length;
  if (count === 0) return null;
  const sum = prices.reduce((total, price) => total + price, 0);
  return Math.floor((sum + Math.floor(count / 2)) / count);
}

function pushPrice(ring: number[], price: number): void {
  ring.push(price);
  if (ring.length > PRICE_RING_CAP) {
    ring.splice(0, ring.length - PRICE_RING_CAP);
  }
}

function seasonBps(item: string): SeasonBps {
  return SEASON_BPS[item] ?? DEFAULT_SEASON_BPS;
}

test("order and fill ids compose tick and per-tick sequence", () => {
  assert.equal(vectors.constants.id_shift, ID_SHIFT);

  for (const vector of vectors.ids.order) {
    assert.ok(vector.seq >= 0 && vector.seq < SEQUENCE_LIMIT, `seq ${vector.seq} overflows`);
    assert.equal(scopedId(vector.tick, vector.seq), vector.id);
    assert.equal(Math.floor(vector.id / SEQUENCE_LIMIT), vector.tick);
    assert.equal(vector.id % SEQUENCE_LIMIT, vector.seq);
  }

  for (const vector of vectors.ids.fill) {
    assert.ok(vector.seq >= 0 && vector.seq < SEQUENCE_LIMIT, `seq ${vector.seq} overflows`);
    assert.equal(scopedId(vector.tick, vector.seq), vector.id);
    assert.equal(Math.floor(vector.id / SEQUENCE_LIMIT), vector.tick);
    assert.equal(vector.id % SEQUENCE_LIMIT, vector.seq);
  }
});

test("sell orders expire sixteen ticks after posting", () => {
  assert.equal(vectors.constants.order_ttl, ORDER_TTL);

  for (const vector of vectors.expires_at) {
    assert.equal(vector.tick + ORDER_TTL, vector.expires_at);
  }
});

test("price ring keeps ten entries and mean rounds half up", () => {
  assert.equal(vectors.constants.price_ring_cap, PRICE_RING_CAP);

  for (const vector of vectors.mean_price) {
    assert.equal(meanPrice(vector.prices), vector.mean);
  }

  for (const vector of vectors.price_ring) {
    const ring: number[] = [];
    for (const price of vector.pushes) pushPrice(ring, price);
    assert.deepEqual(ring, vector.ring);
    assert.equal(ring.length <= PRICE_RING_CAP, true);
    assert.equal(meanPrice(ring), vector.mean);
  }
});

test("season multipliers match recipes.rs for all eighteen items", () => {
  const rows = vectors.season_bps.items;
  assert.deepEqual(
    rows.map((row) => row.item),
    [...ALL_ITEMS],
  );
  assert.equal(rows.length, 18);
  assert.equal(vectors.season_bps.default, 1000);

  for (const row of rows) {
    assert.deepEqual(row.bps, seasonBps(row.item));
  }

  assert.deepEqual(seasonBps("wheat"), [1200, 1500, 1000, 0]);
  assert.deepEqual(seasonBps("vegetables"), [1200, 1500, 1000, 0]);
  assert.deepEqual(seasonBps("herbs"), [1500, 1200, 800, 0]);
  assert.deepEqual(seasonBps("eggs"), [1500, 1000, 800, 500]);
  assert.deepEqual(seasonBps("milk"), [1200, 1000, 800, 600]);
  assert.deepEqual(seasonBps("firewood"), [800, 800, 1200, 1500]);
  assert.deepEqual(seasonBps("cloth"), [1000, 1000, 1000, 1200]);
  assert.deepEqual(seasonBps("unknown"), DEFAULT_SEASON_BPS);
});

test("sleep roll and quality match the Rust dawn rule", () => {
  for (const vector of vectors.sleep.rolls) {
    assert.equal(sleepRoll(vector.tick, vector.agent_index), vector.roll);
  }

  for (const vector of vectors.sleep.qualities) {
    assert.equal(sleepQuality(vector.roll, vector.sickness), vector.quality);
  }
});

test("calendar maps ticks to hour, day, and season", () => {
  assert.equal(TICKS_PER_DAY, vectors.constants.ticks_per_day);
  assert.equal(TICKS_PER_SEASON, vectors.constants.ticks_per_season);
  assert.equal(TICKS_PER_DAY * 7, TICKS_PER_SEASON);

  for (const vector of vectors.calendar) {
    assert.equal(seasonForTick(vector.tick), vector.season);
    assert.equal(dayOfSeason(vector.tick), vector.day);
    assert.equal(hourOfDay(vector.tick), vector.hour);
    assert.equal(timeLabel(vector.tick), vector.label);
  }
});
