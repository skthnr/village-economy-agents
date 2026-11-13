import {
  hourOfDay,
  type Action,
  type InventoryLine,
  type Perception,
} from "./perception.js";

export type PolicyMode = "auto" | "policy" | "llm";

interface Recipe {
  output: string;
  base_qty: number;
  inputs: readonly (readonly [string, number])[];
  location: string;
  skill: string;
  needs_tool: boolean;
}

export const ALL_ITEMS: readonly string[] = [
  "wheat",
  "flour",
  "bread",
  "meat",
  "milk",
  "eggs",
  "vegetables",
  "herbs",
  "medicine",
  "iron_ore",
  "coal",
  "iron_tools",
  "timber",
  "firewood",
  "furniture",
  "ale",
  "meal",
  "cloth",
];

export const AGENT_ORDER: readonly string[] = [
  "hans",
  "ida",
  "konrad",
  "ulrich",
  "bertram",
  "gerda",
  "anselm",
  "volker",
  "wulf",
  "liesel",
  "sybille",
  "friedrich",
  "otto",
  "pater_markus",
  "dieter",
  "magda",
  "heinrich",
  "elke",
  "rupert",
];

const RECIPES: readonly Recipe[] = [
  { output: "wheat", base_qty: 4, inputs: [], location: "Farm 1", skill: "farmer", needs_tool: true },
  { output: "milk", base_qty: 3, inputs: [], location: "Farm 2", skill: "cattle", needs_tool: false },
  { output: "meat", base_qty: 2, inputs: [], location: "Farm 2", skill: "cattle", needs_tool: true },
  { output: "eggs", base_qty: 2, inputs: [], location: "Farm 3", skill: "farmer", needs_tool: false },
  {
    output: "vegetables",
    base_qty: 3,
    inputs: [],
    location: "Farm 3",
    skill: "farmer",
    needs_tool: true,
  },
  {
    output: "flour",
    base_qty: 2,
    inputs: [["wheat", 3]],
    location: "Mill",
    skill: "miller",
    needs_tool: false,
  },
  {
    output: "bread",
    base_qty: 4,
    inputs: [["flour", 1]],
    location: "Bakery",
    skill: "baker",
    needs_tool: false,
  },
  {
    output: "iron_tools",
    base_qty: 1,
    inputs: [
      ["iron_ore", 2],
      ["coal", 1],
    ],
    location: "Forge",
    skill: "blacksmith",
    needs_tool: false,
  },
  {
    output: "furniture",
    base_qty: 1,
    inputs: [["timber", 3]],
    location: "Carpenter Shop",
    skill: "carpenter",
    needs_tool: true,
  },
  {
    output: "medicine",
    base_qty: 1,
    inputs: [["herbs", 3]],
    location: "Healer's Hut",
    skill: "healer",
    needs_tool: false,
  },
  {
    output: "ale",
    base_qty: 4,
    inputs: [["wheat", 2]],
    location: "Tavern",
    skill: "tavern",
    needs_tool: false,
  },
  {
    output: "meal",
    base_qty: 3,
    inputs: [
      ["meat", 1],
      ["vegetables", 1],
    ],
    location: "Tavern",
    skill: "tavern",
    needs_tool: false,
  },
  {
    output: "cloth",
    base_qty: 1,
    inputs: [],
    location: "Seamstress Cottage",
    skill: "seamstress",
    needs_tool: false,
  },
  {
    output: "timber",
    base_qty: 3,
    inputs: [],
    location: "Forest",
    skill: "woodcutter",
    needs_tool: true,
  },
  {
    output: "firewood",
    base_qty: 4,
    inputs: [],
    location: "Forest",
    skill: "woodcutter",
    needs_tool: true,
  },
  {
    output: "herbs",
    base_qty: 2,
    inputs: [],
    location: "Forest",
    skill: "healer",
    needs_tool: false,
  },
  {
    output: "iron_ore",
    base_qty: 3,
    inputs: [],
    location: "Mine",
    skill: "miner",
    needs_tool: true,
  },
  {
    output: "coal",
    base_qty: 2,
    inputs: [],
    location: "Mine",
    skill: "miner",
    needs_tool: true,
  },
];

const SATIATION: Readonly<Record<string, number>> = {
  bread: 2,
  meal: 3,
  meat: 2,
  vegetables: 1,
  eggs: 1,
  milk: 1,
  ale: 0,
};

const SURPLUS_RESERVE: Readonly<Record<string, number>> = {
  wheat: 3,
  flour: 1,
  bread: 1,
  meat: 1,
  milk: 1,
  eggs: 1,
  vegetables: 1,
  herbs: 3,
  medicine: 1,
  iron_ore: 2,
  coal: 1,
  iron_tools: 1,
  timber: 3,
  firewood: 1,
  furniture: 0,
  ale: 1,
  meal: 1,
  cloth: 0,
};

const HUNGER_EAT_THRESHOLD = 4;
const DEFAULT_PRICE = 99n;
export const POLICY_PHASE_COUNT = 3;
const POLICY_PHASE_POST = 1;
const POLICY_PHASE_BUY = 2;

export function resolvePolicyMode(
  requested: PolicyMode,
  hasApiKey: boolean,
): "policy" | "llm" {
  if (requested === "policy") return "policy";
  return hasApiKey ? "llm" : "policy";
}

const AGENT_INDEX = new Map(AGENT_ORDER.map((name, index) => [name, index]));

export function agentIndex(agent: string): number {
  const direct = AGENT_INDEX.get(agent);
  if (direct !== undefined) return direct;
  let hash = 0;
  for (const character of agent) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % AGENT_ORDER.length;
}

export function policyPhase(agent: string, tick: number): number {
  return (tick + agentIndex(agent)) % POLICY_PHASE_COUNT;
}

export function decideActions(agent: string, perception: Perception): Action[] {
  const hour = hourOfDay(perception.tick);

  if (perception.body.hunger >= HUNGER_EAT_THRESHOLD) {
    const food = cheapestOwnedEdible(perception);
    if (food !== undefined) {
      return [{ action_type: "eat", item: food, quantity: "1" }];
    }
    const purchase = cheapestEdiblePurchase(agent, perception);
    if (purchase !== undefined) {
      return [purchase];
    }
  }

  const actions: Action[] = [];

  if (hour >= perception.profile.work_start && hour < perception.profile.work_end) {
    if (perception.location !== perception.profile.work) {
      return [{ action_type: "move_to", location: perception.profile.work }];
    }
    const recipe = producibleRecipe(perception);
    if (recipe !== undefined) {
      actions.push({
        action_type: "produce",
        item: recipe.output,
        location: perception.location,
      });
    }
  } else if (perception.location !== perception.profile.home) {
    return [{ action_type: "move_to", location: perception.profile.home }];
  }

  const phase = policyPhase(agent, perception.tick);

  if (phase === POLICY_PHASE_POST) {
    const sale = surplusSale(agent, perception);
    if (sale !== undefined) {
      actions.push(sale);
    }
  } else if (phase === POLICY_PHASE_BUY && actions.length === 0) {
    const purchase = cheapestEdiblePurchase(agent, perception);
    if (purchase !== undefined) {
      actions.push(purchase);
    }
  }

  return actions;
}

function producibleRecipe(perception: Perception): Recipe | undefined {
  const skill = perception.profile.skill;
  return RECIPES.find(
    (recipe) =>
      recipe.skill === skill &&
      (recipe.location === perception.location ||
        (recipe.location.startsWith("Farm ") && perception.location.startsWith("Farm "))) &&
      hasInputs(perception, recipe) &&
      (!recipe.needs_tool || (perception.tool !== null && perception.tool.durability > 0)),
  );
}

function hasInputs(perception: Perception, recipe: Recipe): boolean {
  return recipe.inputs.every(
    ([item, quantity]) => inventoryQty(perception, item) >= BigInt(quantity),
  );
}

function cheapestOwnedEdible(perception: Perception): string | undefined {
  const edibles = perception.mirrors.inventory
    .filter((line) => (SATIATION[line.item] ?? 0) > 0 && BigInt(line.quantity) > 0n)
    .sort(compareByPriceThenRank(perception));
  return edibles[0]?.item;
}

function cheapestEdiblePurchase(agent: string, perception: Perception): Action | undefined {
  const wallet = BigInt(perception.mirrors.wallet);
  const candidates = perception.order_book
    .filter(
      (order) =>
        order.side === "sell" &&
        (SATIATION[order.item] ?? 0) > 0 &&
        BigInt(order.quantity) > 0n &&
        !isOwnAgent(agent, order.agent_id),
    )
    .sort(compareByPriceThenRank(perception));

  for (const order of candidates) {
    const price = BigInt(order.price);
    if (price <= 0n || wallet < price) continue;
    const offered = BigInt(order.quantity);
    const affordable = wallet / price;
    const quantity = offered < affordable ? offered : affordable;
    if (quantity <= 0n) continue;
    return {
      action_type: "buy_item",
      item: order.item,
      quantity: quantity.toString(),
      max_price: order.price,
      order_id: order.id,
    };
  }

  return undefined;
}

function surplusSale(agent: string, perception: Perception): Action | undefined {
  for (const item of ALL_ITEMS) {
    const quantity = inventoryQty(perception, item);
    const reserve = BigInt(SURPLUS_RESERVE[item] ?? 0);
    if (quantity <= reserve) continue;
    const alreadyListed = perception.order_book.some(
      (order) =>
        order.side === "sell" && order.item === item && isOwnAgent(agent, order.agent_id),
    );
    if (alreadyListed) continue;
    const price = priceOf(perception, item);
    return {
      action_type: "post_order",
      side: "sell",
      item,
      quantity: (quantity - reserve).toString(),
      price: (price > 0n ? price : 1n).toString(),
    };
  }
  return undefined;
}

function inventoryQty(perception: Perception, item: string): bigint {
  return perception.mirrors.inventory
    .filter((line) => line.item === item)
    .reduce((total, line) => total + BigInt(line.quantity), 0n);
}

function priceOf(perception: Perception, item: string): bigint {
  const line = perception.price_index.find((entry) => entry.item === item);
  return line === undefined ? DEFAULT_PRICE : BigInt(line.price);
}

function compareByPriceThenRank(
  perception: Perception,
): (left: InventoryLine | { item: string; price: string }, right: InventoryLine | { item: string; price: string }) => number {
  return (left, right) => {
    const leftPrice = "price" in left ? BigInt(left.price) : priceOf(perception, left.item);
    const rightPrice = "price" in right ? BigInt(right.price) : priceOf(perception, right.item);
    if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
    return itemRank(left.item) - itemRank(right.item);
  };
}

function itemRank(item: string): number {
  const rank = ALL_ITEMS.indexOf(item);
  return rank < 0 ? ALL_ITEMS.length : rank;
}

function isOwnAgent(agent: string, accountId: string): boolean {
  return accountId === agent || accountId.startsWith(`${agent}.`);
}
