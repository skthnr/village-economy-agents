import assert from "node:assert/strict";
import test from "node:test";
import { teraToGas } from "near-api-js";

import {
  parsePerception,
  type Action,
} from "../orchestrator/src/perception.js";
import {
  AGENT_ORDER,
  decideActions,
} from "../orchestrator/src/policy-agents.js";
import {
  buyOrder,
  cancelOrder,
  deployEconomy,
  findOrder,
  marketCall,
  ftBalanceOf,
  getEconomySnapshot,
  getOrderBook,
  getPerception,
  mtBalanceOf,
  mtSupply,
  mtTransfer,
  postBuyOrder,
  postSellOrder,
  requireAgent,
  executeTick,
  startHarness,
  stopHarness,
  submitCoreActions,
  viewWorld,
  type AgentHandle,
  type Economy,
  type Harness,
} from "./sandbox.js";

const TICKS = Number(process.env.EIDOLON_TICKS ?? 112);
const MILLER_STOP_TICK = 48;
const SCENARIO_TICKS = Number(process.env.EIDOLON_TICKS ?? 49);

interface SimulationTrace {
  snapshot: string;
  breadSupply: bigint[];
  flourSupply: bigint[];
  millerFlour: bigint[];
  bakerFlour: bigint[];
  failures: string[];
}

interface TickDecision {
  name: string;
  agent: AgentHandle;
  actions: Action[];
}

function isMarketAction(action: Action): boolean {
  return (
    action.action_type === "post_order" ||
    action.action_type === "buy_item" ||
    action.action_type === "cancel_order"
  );
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

async function executeMarketAction(
  economy: Economy,
  agent: AgentHandle,
  action: Action,
): Promise<void> {
  if (action.action_type === "post_order") {
    const item = required(action.item, "post_order item");
    const quantity = BigInt(required(action.quantity, "post_order quantity"));
    const price = BigInt(required(action.price, "post_order price"));
    if (action.side === "sell") {
      await postSellOrder(economy, agent, item, quantity, price);
      return;
    }
    if (action.side === "buy") {
      await postBuyOrder(economy, agent, item, quantity, price);
      return;
    }
    throw new Error(`post_order needs a side, got ${String(action.side)}`);
  }

  if (action.action_type === "buy_item") {
    const orderId = required(action.order_id, "buy_item order_id");
    const maxPrice = BigInt(required(action.max_price, "buy_item max_price"));
    const quantity = BigInt(required(action.quantity, "buy_item quantity"));
    await buyOrder(economy, agent, orderId, maxPrice, quantity);
    return;
  }

  if (action.action_type === "cancel_order") {
    await cancelOrder(economy, agent, required(action.order_id, "cancel order_id"));
    return;
  }

  throw new Error(`not a market action: ${action.action_type}`);
}


async function runPolicySimulation(economy: Economy, withActions = true): Promise<SimulationTrace> {
  const trace: SimulationTrace = {
    snapshot: "",
    breadSupply: [],
    flourSupply: [],
    millerFlour: [],
    bakerFlour: [],
    failures: [],
  };
  const gerda = requireAgent(economy, "gerda");

  if (!withActions) {
    for (let tick = 1; tick <= TICKS; tick += 1) {
      await executeTick(economy);
    }
    trace.snapshot = JSON.stringify(await getEconomySnapshot(economy)).replaceAll(
      `.${economy.ids.world}`,
      ".world.sandbox",
    );
    return trace;
  }
  const anselm = requireAgent(economy, "anselm");

  for (let tick = 1; tick <= TICKS; tick += 1) {
    const decisions: TickDecision[] = await Promise.all(
      AGENT_ORDER.map(async (name) => {
        const agent = requireAgent(economy, name);
        const perception = parsePerception(
          await getPerception(economy, agent.accountId),
        );
        return {
          name,
          agent,
          actions: decideActions(name, perception),
        };
      }),
    );

    // Market actions are submitted in the fixed agent order and settled before
    // the next one, so a 12-line order book cannot race between two runs.
    for (const decision of decisions) {
      if (decision.name === "gerda" && tick >= MILLER_STOP_TICK) continue;
      for (const action of decision.actions) {
        if (!isMarketAction(action)) continue;
        try {
          await executeMarketAction(economy, decision.agent, action);
        } catch (error) {
          if (action.action_type !== "buy_item") throw error;
          // A previous buyer in this same tick can exhaust the targeted order.
          trace.failures.push(
            `${tick}:${decision.name}:${action.action_type}:${action.order_id ?? ""}`,
          );
        }
      }
    }

    await Promise.all(
      decisions.map((decision) => {
        if (decision.name === "gerda" && tick >= MILLER_STOP_TICK) {
          return Promise.resolve(0);
        }
        return submitCoreActions(economy, decision.agent, decision.actions);
      }),
    );

    await executeTick(economy);

    const [bread, flour, millerFlour, bakerFlour] = await Promise.all([
      mtSupply(economy, "bread"),
      mtSupply(economy, "flour"),
      mtBalanceOf(economy, gerda.accountId, "flour"),
      mtBalanceOf(economy, anselm.accountId, "flour"),
    ]);
    trace.breadSupply.push(bread);
    trace.flourSupply.push(flour);
    trace.millerFlour.push(millerFlour);
    trace.bakerFlour.push(bakerFlour);
  }

  trace.snapshot = JSON.stringify(await getEconomySnapshot(economy)).replaceAll(
    `.${economy.ids.world}`,
    ".world.sandbox",
  );
  return trace;
}

function assertDeterminism(first: SimulationTrace, second: SimulationTrace): void {
  assert.equal(
    first.snapshot,
    second.snapshot,
    "two 112-tick runs must produce identical get_economy_snapshot() JSON",
  );
  assert.deepEqual(
    first.flourSupply.map(String),
    second.flourSupply.map(String),
    "flour supply trace must be identical",
  );
  assert.deepEqual(
    first.breadSupply.map(String),
    second.breadSupply.map(String),
    "bread supply trace must be identical",
  );
  assert.deepEqual(
    first.millerFlour.map(String),
    second.millerFlour.map(String),
    "miller flour trace must be identical",
  );
  assert.deepEqual(
    first.bakerFlour.map(String),
    second.bakerFlour.map(String),
    "baker flour trace must be identical",
  );
  assert.deepEqual(first.failures, second.failures);

  const snapshot = JSON.parse(first.snapshot) as {
    tick: number;
    price_index: [string, string][];
    wealth: { agent: string; wallet: string; inventory_value: string }[];
  };
  assert.equal(snapshot.price_index.length, 18, "snapshot carries the 18 prices");
  assert.equal(snapshot.wealth.length, 19, "snapshot carries all 19 villagers");
  assert.ok(snapshot.tick >= 1 && snapshot.tick <= TICKS);
}

function assertBreadHaltsWithoutFlour(trace: SimulationTrace): void {
  assert.equal(
    trace.bakerFlour[TICKS - 1],
    0n,
    "the baker has no flour left at the end of the week",
  );
  const firstZeroFlour = trace.bakerFlour.findIndex((value) => value === 0n);
  assert.ok(firstZeroFlour >= 0, "baker consumes the starting flour");
  const lastBreadIncrease = trace.breadSupply.reduce(
    (last, value, index) =>
      index > 0 && value > (trace.breadSupply[index - 1] ?? value)
        ? index
        : last,
    -1,
  );
  assert.ok(
    lastBreadIncrease <= firstZeroFlour,
    `bread cannot increase after the baker's flour runs out (last increase ${lastBreadIncrease}, first zero ${firstZeroFlour})`,
  );

  const stoppedIndex = MILLER_STOP_TICK - 1;
  const stoppedFlour = trace.flourSupply[stoppedIndex];
  assert.ok(stoppedFlour !== undefined);
  for (let index = stoppedIndex; index < TICKS; index += 1) {
    assert.equal(
      trace.flourSupply[index],
      stoppedFlour,
      `flour supply changed after the miller stopped (index ${index})`,
    );
  }

}

async function assertMirrorEqualsLedger(economy: Economy, name: string): Promise<void> {
  const agent = requireAgent(economy, name);
  const perception = parsePerception(await getPerception(economy, agent.accountId));
  assert.equal(
    perception.mirrors.wallet,
    (await ftBalanceOf(economy, agent.accountId)).toString(),
    `${name}: coin mirror must equal ft_balance_of`,
  );
}

async function scenarioActionsBeforeTick(
  economy: Economy,
  tick: number,
): Promise<void> {
  if (tick === 1) {
    const bertram = requireAgent(economy, "bertram");
    const wulf = requireAgent(economy, "wulf");
    const sybille = requireAgent(economy, "sybille");
    const konrad = requireAgent(economy, "konrad");
    const gerda = requireAgent(economy, "gerda");
    const hans = requireAgent(economy, "hans");
    const otto = requireAgent(economy, "otto");
    const anselm = requireAgent(economy, "anselm");

    await postSellOrder(economy, bertram, "wheat", 3n, 1n);
    await postSellOrder(economy, wulf, "timber", 1n, 5n);
    await postSellOrder(economy, sybille, "herbs", 1n, 7n);
    await postSellOrder(economy, konrad, "milk", 3n, 2n);
    await submitCoreActions(economy, gerda, [
      { action_type: "move_to", location: "Village Square" },
    ]);
    await submitCoreActions(economy, hans, [
      { action_type: "move_to", location: "Village Square" },
    ]);
    await submitCoreActions(economy, otto, [
      { action_type: "move_to", location: "Village Square" },
    ]);
    await submitCoreActions(economy, anselm, [
      { action_type: "produce", item: "bread" },
    ]);
    return;
  }

  if (tick === 2) {
    const gerda = requireAgent(economy, "gerda");
    const anselm = requireAgent(economy, "anselm");
    const hans = requireAgent(economy, "hans");
    const otto = requireAgent(economy, "otto");

    const wheatOrder = findOrder(
      await getOrderBook(economy, gerda.accountId),
      (order) =>
        order.side === "sell" &&
        order.item === "wheat" &&
        order.agent_id === requireAgent(economy, "bertram").accountId,
    );
    await buyOrder(economy, gerda, wheatOrder.id, 1n, 3n);
    await submitCoreActions(economy, gerda, [
      { action_type: "move_to", location: "Mill" },
    ]);

    const timberOrder = findOrder(
      await getOrderBook(economy, hans.accountId),
      (order) =>
        order.side === "sell" &&
        order.item === "timber" &&
        order.agent_id === requireAgent(economy, "wulf").accountId,
    );
    const hansCoinBefore = await ftBalanceOf(economy, hans.accountId);
    const wulfCoinBefore = await ftBalanceOf(
      economy,
      requireAgent(economy, "wulf").accountId,
    );
    const hansTimberBefore = await mtBalanceOf(economy, hans.accountId, "timber");
    const wulfTimberBefore = await mtBalanceOf(
      economy,
      requireAgent(economy, "wulf").accountId,
      "timber",
    );
    const timberSupplyBefore = await mtSupply(economy, "timber");

    await buyOrder(economy, hans, timberOrder.id, 5n, 1n);

    assert.equal(
      await ftBalanceOf(economy, hans.accountId),
      hansCoinBefore - 5n,
      "buyer coin decreases by price x quantity",
    );
    assert.equal(
      await ftBalanceOf(economy, requireAgent(economy, "wulf").accountId),
      wulfCoinBefore + 5n,
      "seller coin increases by price x quantity",
    );
    assert.equal(
      await mtBalanceOf(economy, hans.accountId, "timber"),
      hansTimberBefore + 1n,
      "buyer receives the exact item quantity",
    );
    assert.equal(
      await mtBalanceOf(economy, requireAgent(economy, "wulf").accountId, "timber"),
      wulfTimberBefore,
      "seller keeps the free remainder",
    );
    assert.equal(
      await mtSupply(economy, "timber"),
      timberSupplyBefore,
      "a trade does not change item supply",
    );
    assert.equal(
      (await getOrderBook(economy, hans.accountId)).some(
        (order) => order.id === timberOrder.id,
      ),
      false,
      "a fully filled sell order leaves the book",
    );

    // Ghost-funds regression: forge the items callback without moving escrow.
    // The world owner controls the items account, so this is the only way to
    // reach the mt_transfer-failure callback deterministically.
    await economy.accounts.items.callFunction({
      contractId: economy.ids.world,
      methodName: "mt_on_transfer",
      args: {
        sender_id: gerda.accountId,
        previous_owner_ids: [gerda.accountId],
        token_ids: ["flour"],
        amounts: ["1"],
        msg: "sell:5",
      },
      gas: teraToGas(100),
      deposit: 0n,
      waitUntil: "FINAL",
    });

    const forgedOrder = findOrder(
      await getOrderBook(economy, otto.accountId),
      (order) =>
        order.side === "sell" &&
        order.item === "flour" &&
        order.agent_id === gerda.accountId,
    );
    const ottoCoinBefore = await ftBalanceOf(economy, otto.accountId);
    const gerdaCoinBefore = await ftBalanceOf(economy, gerda.accountId);
    const ottoFlourBefore = await mtBalanceOf(economy, otto.accountId, "flour");

    try {
      await buyOrder(economy, otto, forgedOrder.id, 5n, 1n);
    } catch {
      // A detached items receipt failure is expected; the callback refund is
      // what this assertion is about.
    }

    const ottoAfterFailure = parsePerception(
      await getPerception(economy, otto.accountId),
    );
    assert.ok(
      ottoAfterFailure.feedback.some((message) =>
        message.includes("purchase failed"),
      ),
      "the failed-fill callback records buyer feedback",
    );

    assert.equal(
      await ftBalanceOf(economy, otto.accountId),
      ottoCoinBefore,
      "failed item transfer refunds the buyer's coin",
    );
    assert.equal(
      await ftBalanceOf(economy, gerda.accountId),
      gerdaCoinBefore,
      "failed item transfer does not pay the seller",
    );
    assert.equal(
      await mtBalanceOf(economy, otto.accountId, "flour"),
      ottoFlourBefore,
      "failed item transfer delivers no item",
    );
    const restored = findOrder(
      await getOrderBook(economy, otto.accountId),
      (order) => order.id === forgedOrder.id,
    );
    assert.equal(
      restored.quantity,
      forgedOrder.quantity,
      "failed fill restores the order quantity",
    );

    // Fund the forged escrow so the cancel/expiry refund successes instead of
    // scheduling another failing items transfer.
    await mtTransfer(economy, gerda, economy.ids.world, "flour", 1n);
    await cancelOrder(economy, gerda, forgedOrder.id);
    assert.equal(
      (await getOrderBook(economy, otto.accountId)).some(
        (order) => order.id === forgedOrder.id,
      ),
      false,
      "the forged order can be cancelled after the refund",
    );
    assert.equal(
      await mtBalanceOf(economy, gerda.accountId, "flour"),
      4n,
      "the miller keeps her starting flour",
    );

    await assert.rejects(
      marketCall(economy, hans, economy.ids.world, "ft_on_transfer", {
        sender_id: hans.accountId,
        amount: "1",
        msg: "buy:1:1",
      }),
      "ft_on_transfer must reject a non-coin caller",
    );
    await assert.rejects(
      marketCall(economy, hans, economy.ids.world, "mt_on_transfer", {
        sender_id: hans.accountId,
        previous_owner_ids: [hans.accountId],
        token_ids: ["wheat"],
        amounts: ["1"],
        msg: "sell:1",
      }),
      "mt_on_transfer must reject a non-items caller",
    );

    // BUY demand path: exact 0.01 N deposit, then owner cancel.
    await postBuyOrder(economy, hans, "wheat", 1n, 1n);
    const demand = findOrder(
      await getOrderBook(economy, hans.accountId),
      (order) => order.side === "buy" && order.agent_id === hans.accountId,
    );
    await cancelOrder(economy, hans, demand.id);
    assert.equal(
      (await getOrderBook(economy, hans.accountId)).some(
        (order) => order.id === demand.id,
      ),
      false,
      "a cancelled BUY order leaves the book",
    );

    await submitCoreActions(economy, anselm, [
      { action_type: "produce", item: "bread" },
    ]);
    return;
  }

  if (tick === 3) {
    await submitCoreActions(economy, requireAgent(economy, "gerda"), [
      { action_type: "produce", item: "flour" },
    ]);
    return;
  }

  if (tick >= 4 && tick <= 9) {
    // The miller is stopped from tick 4; keep asking the baker to bake so the
    // halt is demonstrated by missing flour, not by missing actions.
    await submitCoreActions(economy, requireAgent(economy, "anselm"), [
      { action_type: "produce", item: "bread" },
    ]);
    return;
  }

  if (tick === 18 || tick === 35) {
    await postSellOrder(economy, requireAgent(economy, "konrad"), "milk", 3n, 2n);
  }
}

async function assertScenarioTick(
  economy: Economy,
  tick: number,
  bread: bigint,
  flour: bigint,
  millerFlour: bigint,
  bakerFlour: bigint,
): Promise<void> {
  if (tick === 1) {
    assert.equal(bread, 12n, "the baker bakes the first flour at tick 1");
    await assertMirrorEqualsLedger(economy, "hans");
    await assertMirrorEqualsLedger(economy, "otto");
  }
  if (tick === 2) {
    assert.equal(bread, 16n, "the baker bakes the second flour at tick 2");
    assert.equal(bakerFlour, 0n, "the baker's starting flour is exhausted");
    await assertMirrorEqualsLedger(economy, "hans");
    await assertMirrorEqualsLedger(economy, "wulf");
    await assertMirrorEqualsLedger(economy, "gerda");
  }
  if (tick === 3) {
    assert.equal(millerFlour, 6n, "the miller mills the bought wheat");
    assert.equal(flour, 6n, "miller production is visible in mt_supply");
  }
  if (tick >= 3 && tick <= 10) {
    assert.equal(bread, 16n, "no bread is baked after the flour runs out");
    assert.equal(
      millerFlour,
      6n,
      "the stopped miller produces no further flour",
    );
    assert.equal(bakerFlour, 0n, "the baker stays out of flour");
    assert.equal(flour, 6n, "miller stop freezes the flour supply");
  }

  if (tick === 17) {
    const sybille = requireAgent(economy, "sybille");
    assert.equal(
      await mtBalanceOf(economy, sybille.accountId, "herbs"),
      5n,
      "expired sell-order escrow returns to the seller",
    );
    assert.equal(
      (await getOrderBook(economy, sybille.accountId)).some(
        (order) =>
          order.side === "sell" &&
          order.item === "herbs" &&
          order.agent_id === sybille.accountId,
      ),
      false,
      "expired sell order is pruned from the book",
    );
    const konrad = requireAgent(economy, "konrad");
    assert.equal(
      await mtBalanceOf(economy, konrad.accountId, "milk"),
      3n,
      "the milk order expires and returns its escrow before spoilage",
    );
  }

  if (tick === 24 || tick === 25) {
    const view = await viewWorld(economy);
    const ottoBody = view.bodies.find(
      ([accountId]) => accountId === requireAgent(economy, "otto").accountId,
    );
    assert.ok(ottoBody !== undefined, "otto is in the world view");
    if (tick === 24) {
      assert.equal(
        ottoBody[1].starvation_ticks,
        2,
        "hunger 5 for two ticks sets the starvation streak",
      );
    } else {
      assert.equal(
        ottoBody[1].hunger,
        5,
        "starvation death happens at hunger 5",
      );
      assert.equal(
        ottoBody[1].starvation_ticks,
        255,
        "the third hunger-5 tick marks permanent starvation death",
      );
    }
  }

  if (tick === 34) {
    const konrad = requireAgent(economy, "konrad");
    assert.equal(
      await mtBalanceOf(economy, konrad.accountId, "milk"),
      3n,
      "the second milk order expires before the spoil deadline",
    );
  }

  if (tick === 49) {
    assert.equal(
      await mtSupply(economy, "milk"),
      0n,
      "spoiled milk is burned from free balance and escrow",
    );
    assert.equal(
      (await getOrderBook(economy, requireAgent(economy, "konrad").accountId)).some(
        (order) => order.side === "sell" && order.item === "milk",
      ),
      false,
      "spoilage cancels the escrowed milk sell order",
    );
  }
}

async function runScenario(economy: Economy): Promise<void> {
  // Scenario (a)-(f): scripted edge cases the policy cannot force on its own.
  for (let tick = 1; tick <= SCENARIO_TICKS; tick += 1) {
    await scenarioActionsBeforeTick(economy, tick);
    if (tick % 10 === 0) {
      console.log(`${economy.tag}: scenario tick ${tick}/${SCENARIO_TICKS}`);
    }
    await executeTick(economy);

    const [bread, flour, millerFlour, bakerFlour] = await Promise.all([
      mtSupply(economy, "bread"),
      mtSupply(economy, "flour"),
      mtBalanceOf(economy, requireAgent(economy, "gerda").accountId, "flour"),
      mtBalanceOf(economy, requireAgent(economy, "anselm").accountId, "flour"),
    ]);
    await assertScenarioTick(
      economy,
      tick,
      bread,
      flour,
      millerFlour,
      bakerFlour,
    );
  }
}

test(
  `scripted ${SCENARIO_TICKS}-tick golden economy (a)-(f)`,
  { timeout: 30 * 60 * 1000 },
  async () => {
    const harness: Harness = await startHarness();
    try {
      const economy = await deployEconomy(harness, "c");
      await runScenario(economy);
    } finally {
      await stopHarness(harness);
    }
  },
);
