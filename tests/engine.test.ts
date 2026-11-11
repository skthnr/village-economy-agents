import assert from "node:assert/strict";
import test from "node:test";

import {
  dayOfSeason,
  hourOfDay,
  isWeekStart,
  parseActions,
  parsePerception,
  renderPerception,
  seasonForTick,
  sleepQuality,
  sleepRoll,
  TICKS_PER_SEASON,
  timeLabel,
  type Perception,
} from "../orchestrator/src/perception.js";
import {
  AGENT_ORDER,
  ALL_ITEMS,
  decideActions,
  POLICY_PHASE_COUNT,
  policyPhase,
  resolvePolicyMode,
} from "../orchestrator/src/policy-agents.js";

const BASE_PERCEPTION: Perception = {
  tick: 4,
  time: "Monday, 09:00",
  season: "spring",
  weather: "Mild, 12°C, sunny",
  location: "Mill",
  body: { hunger: 1, energy: 90, sleep_quality: 90, sickness: 0 },
  profile: { skill: "miller", home: "Mill", work: "Mill", work_start: 9, work_end: 17 },
  mirrors: {
    wallet: "45",
    inventory: [
      { item: "wheat", quantity: "3" },
      { item: "flour", quantity: "4" },
    ],
  },
  tool: null,
  price_index: [
    { item: "wheat", price: "2" },
    { item: "flour", price: "5" },
    { item: "bread", price: "3" },
    { item: "meat", price: "8" },
  ],
  order_book: [],
  feedback: ["Produced 2 flour."],
};

function withPerception(patch: Partial<Perception>): Perception {
  return {
    ...BASE_PERCEPTION,
    ...patch,
    body: { ...BASE_PERCEPTION.body, ...patch.body },
    profile: { ...BASE_PERCEPTION.profile, ...patch.profile },
    mirrors: { ...BASE_PERCEPTION.mirrors, ...patch.mirrors },
  };
}

test("scripted policy is deterministic", () => {
  const first = JSON.stringify(decideActions("gerda", BASE_PERCEPTION));
  const second = JSON.stringify(decideActions("gerda", BASE_PERCEPTION));
  assert.equal(first, second);
  assert.deepEqual(decideActions("gerda", BASE_PERCEPTION), [
    { action_type: "produce", item: "flour", location: "Mill" },
  ]);
});

test("hunger four eats the cheapest edible", () => {
  const hungry = withPerception({
    body: { hunger: 4, energy: 80, sleep_quality: 90, sickness: 0 },
    mirrors: {
      wallet: "45",
      inventory: [
        { item: "bread", quantity: "1" },
        { item: "meat", quantity: "1" },
        { item: "flour", quantity: "4" },
      ],
    },
  });
  assert.deepEqual(decideActions("gerda", hungry), [
    { action_type: "eat", item: "bread", quantity: "1" },
  ]);
});

test("work window moves and produces deterministically", () => {
  const away = withPerception({ location: "Cottage 2" });
  assert.deepEqual(decideActions("gerda", away), [
    { action_type: "move_to", location: "Mill" },
  ]);

  const evening = withPerception({ tick: 16, time: "Monday, 21:00", location: "Cottage 2" });
  assert.deepEqual(decideActions("gerda", evening), [
    { action_type: "move_to", location: "Mill" },
  ]);

  const noInputs = withPerception({
    mirrors: { wallet: "45", inventory: [{ item: "flour", quantity: "4" }] },
  });
  assert.deepEqual(decideActions("gerda", noInputs), []);
});

test("surplus food is listed and cheapest food is bought", () => {
  const saleTick = 5;
  const seller = withPerception({
    tick: saleTick,
    time: "Monday, 10:00",
    mirrors: {
      wallet: "45",
      inventory: [
        { item: "wheat", quantity: "3" },
        { item: "bread", quantity: "3" },
      ],
    },
  });
  const sale = decideActions("gerda", seller);
  assert.deepEqual(sale.at(-1), {
    action_type: "post_order",
    side: "sell",
    item: "bread",
    quantity: "2",
    price: "3",
  });

  const buyTick = 6;
  const buyer = withPerception({
    tick: buyTick,
    time: "Monday, 11:00",
    mirrors: { wallet: "45", inventory: [] },
    order_book: [
      {
        id: 11,
        agent_id: "anselm.world.eidolon.testnet",
        side: "sell",
        item: "bread",
        quantity: "4",
        price: "3",
        posted_tick: 5,
        expires_at: 21,
      },
      {
        id: 12,
        agent_id: "konrad.world.eidolon.testnet",
        side: "sell",
        item: "meat",
        quantity: "1",
        price: "8",
        posted_tick: 5,
        expires_at: 21,
      },
    ],
  });
  assert.deepEqual(decideActions("gerda", buyer), [
    {
      action_type: "buy_item",
      item: "bread",
      quantity: "4",
      max_price: "3",
      order_id: 11,
    },
  ]);
});

test("perception round-trips and renders sections in origin order", () => {
  const parsed = parsePerception(JSON.stringify(BASE_PERCEPTION));
  assert.deepEqual(parsed, BASE_PERCEPTION);

  const text = renderPerception(parsed);
  const sections = [
    "Location:",
    "Weather:",
    "Inventory:",
    "Wallet:",
    "Tools:",
    "Marketplace board:",
    "Last tick feedback:",
  ];
  let previous = -1;
  for (const section of sections) {
    const index = text.indexOf(section);
    assert.ok(index > previous, `${section} must follow the previous section`);
    previous = index;
  }
  assert.match(text, /Inventory: wheat ×3, flour ×4/);
  assert.match(text, /Wallet: 45 coin/);
  assert.match(text, /Tools: none/);
});

test("policy phases stay in the spread bounds", () => {
  for (const agent of AGENT_ORDER) {
    for (let tick = 1; tick <= 32; tick += 1) {
      const phase = policyPhase(agent, tick);
      assert.ok(phase >= 0 && phase < POLICY_PHASE_COUNT);
    }
  }
  const phases = new Set(AGENT_ORDER.map((agent) => policyPhase(agent, 1)));
  assert.equal(phases.size, POLICY_PHASE_COUNT);
  assert.equal(ALL_ITEMS.length, 18);
});

test("llm fallback selection is pure", () => {
  assert.equal(resolvePolicyMode("auto", false), "policy");
  assert.equal(resolvePolicyMode("auto", true), "llm");
  assert.equal(resolvePolicyMode("llm", false), "policy");
  assert.equal(resolvePolicyMode("llm", true), "llm");
  assert.equal(resolvePolicyMode("policy", true), "policy");
});

test("time and sleep constants match the Rust formulas", () => {
  assert.equal(TICKS_PER_SEASON, 112);
  assert.equal(sleepRoll(0, 0), 0);
  assert.equal(sleepRoll(3, 2), 2);
  assert.equal(sleepRoll(19, 0), 19);
  assert.equal(sleepRoll(32, 1), 39);
  assert.equal(sleepQuality(49, 0), 90);
  assert.equal(sleepQuality(50, 0), 70);
  assert.equal(sleepQuality(84, 0), 70);
  assert.equal(sleepQuality(85, 0), 50);
  assert.equal(sleepQuality(0, 2), 40);

  assert.equal(seasonForTick(1), "spring");
  assert.equal(seasonForTick(113), "summer");
  assert.equal(seasonForTick(225), "autumn");
  assert.equal(seasonForTick(337), "winter");
  assert.equal(seasonForTick(449), "spring");

  assert.equal(dayOfSeason(1), 1);
  assert.equal(dayOfSeason(16), 1);
  assert.equal(dayOfSeason(17), 2);
  assert.equal(dayOfSeason(112), 7);
  assert.equal(dayOfSeason(113), 1);

  assert.equal(hourOfDay(1), 6);
  assert.equal(hourOfDay(16), 21);
  assert.equal(hourOfDay(17), 6);
  assert.equal(timeLabel(1), "Monday, 06:00");
  assert.equal(timeLabel(16), "Monday, 21:00");
  assert.equal(timeLabel(17), "Tuesday, 06:00");
  assert.equal(isWeekStart(1), true);
  assert.equal(isWeekStart(113), true);
  assert.equal(isWeekStart(2), false);
});

test("llm action validation rejects unknown action types", () => {
  assert.deepEqual(parseActions([{ action_type: "eat", item: "bread", quantity: 1 }]), [
    { action_type: "eat", item: "bread", quantity: "1" },
  ]);
  assert.throws(() => parseActions([{ action_type: "dance" }]), /action_type/);
  assert.throws(() => parseActions([{ action_type: "produce", quantity: "-1" }]), /integer/);
});

test("perception accepts tuple item quantities", () => {
  const raw = {
    ...BASE_PERCEPTION,
    mirrors: {
      wallet: "0",
      inventory: [
        ["bread", "2"],
        ["meat", "1"],
      ],
    },
    price_index: [
      ["bread", "3"],
      ["meat", "8"],
    ],
  };
  const parsed = parsePerception(JSON.stringify(raw));
  assert.deepEqual(parsed.mirrors.inventory, [
    { item: "bread", quantity: "2" },
    { item: "meat", quantity: "1" },
  ]);
  assert.deepEqual(parsed.price_index, [
    { item: "bread", price: "3" },
    { item: "meat", price: "8" },
  ]);
});
