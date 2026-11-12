export type Season = "spring" | "summer" | "autumn" | "winter";

export type ActionType =
  | "move_to"
  | "speak"
  | "produce"
  | "eat"
  | "post_order"
  | "buy_item"
  | "cancel_order";

export type OrderSide = "sell" | "buy";

export interface BodyView {
  hunger: number;
  energy: number;
  sleep_quality: number;
  sickness: number;
}

export interface AgentProfileView {
  skill: string;
  home: string;
  work: string;
  work_start: number;
  work_end: number;
}

export interface InventoryLine {
  item: string;
  quantity: string;
}

export interface MirrorView {
  wallet: string;
  inventory: InventoryLine[];
}

export interface ToolView {
  item: string;
  durability: number;
}

export interface OrderView {
  id: number;
  agent_id: string;
  side: OrderSide;
  item: string;
  quantity: string;
  price: string;
  posted_tick: number;
  expires_at: number;
}

export interface PriceLine {
  item: string;
  price: string;
}

export interface Perception {
  tick: number;
  time: string;
  season: Season;
  weather: string;
  location: string;
  body: BodyView;
  profile: AgentProfileView;
  mirrors: MirrorView;
  tool: ToolView | null;
  price_index: PriceLine[];
  order_book: OrderView[];
  feedback: string[];
}

interface ActionBase {
  text?: string;
  target?: string;
}

export type Action =
  | (ActionBase & { action_type: "move_to"; location: string })
  | (ActionBase & { action_type: "speak"; text: string })
  | (ActionBase & {
      action_type: "produce";
      item: string;
      quantity?: string;
      location?: string;
    })
  | (ActionBase & { action_type: "eat"; item: string; quantity?: string })
  | (ActionBase & {
      action_type: "post_order";
      side: OrderSide;
      item: string;
      quantity: string;
      price: string;
    })
  | (ActionBase & {
      action_type: "buy_item";
      order_id: number;
      max_price: string;
      quantity: string;
      item?: string;
    })
  | (ActionBase & { action_type: "cancel_order"; order_id: number });

export const TICKS_PER_DAY = 16;
export const DAYS_PER_SEASON = 7;
export const TICKS_PER_SEASON = TICKS_PER_DAY * DAYS_PER_SEASON;

const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"];
const ACTION_TYPES: readonly ActionType[] = [
  "move_to",
  "speak",
  "produce",
  "eat",
  "post_order",
  "buy_item",
  "cancel_order",
];

export function sleepRoll(tick: number, agentIndex: number): number {
  return ((Math.floor(tick / TICKS_PER_DAY) * 19 + agentIndex) % 100 + 100) % 100;
}

export function sleepQuality(roll: number, sickness: number): number {
  if (sickness >= 2) return 40;
  if (roll < 50) return 90;
  if (roll < 85) return 70;
  return 50;
}

export function seasonForTick(tick: number): Season {
  return SEASONS[Math.floor((tick - 1) / TICKS_PER_SEASON) % 4] ?? "spring";
}

export function dayOfSeason(tick: number): number {
  return (Math.floor((tick - 1) / TICKS_PER_DAY) % DAYS_PER_SEASON) + 1;
}

export function hourOfDay(tick: number): number {
  return 6 + ((tick - 1) % TICKS_PER_DAY);
}

export function dayName(tick: number): string {
  return DAY_NAMES[Math.floor((tick - 1) / TICKS_PER_DAY) % 7] ?? "Monday";
}

export function timeLabel(tick: number): string {
  return `${dayName(tick)}, ${String(hourOfDay(tick)).padStart(2, "0")}:00`;
}

export function isWeekStart(tick: number): boolean {
  return tick >= 1 && (tick - 1) % TICKS_PER_SEASON === 0;
}

export function parsePerception(json: string): Perception {
  const root = asRecord(JSON.parse(json), "perception");
  const tick = numberField(root, "tick", "perception");
  const season = seasonField(root, "season", "perception");
  const bodyRecord = asRecord(field(root, "body", "perception"), "perception.body");
  const profileRecord = asRecord(field(root, "profile", "perception"), "perception.profile");
  const mirrorRecord = asRecord(field(root, "mirrors", "perception"), "perception.mirrors");
  const toolValue = field(root, "tool", "perception");

  return {
    tick,
    time: stringField(root, "time", "perception"),
    season,
    weather: stringField(root, "weather", "perception"),
    location: stringField(root, "location", "perception"),
    body: {
      hunger: numberField(bodyRecord, "hunger", "perception.body"),
      energy: numberField(bodyRecord, "energy", "perception.body"),
      sleep_quality: numberField(bodyRecord, "sleep_quality", "perception.body"),
      sickness: numberField(bodyRecord, "sickness", "perception.body"),
    },
    profile: {
      skill: stringField(profileRecord, "skill", "perception.profile"),
      home: stringField(profileRecord, "home", "perception.profile"),
      work: stringField(profileRecord, "work", "perception.profile"),
      work_start: numberField(profileRecord, "work_start", "perception.profile"),
      work_end: numberField(profileRecord, "work_end", "perception.profile"),
    },
    mirrors: {
      wallet: quantityField(mirrorRecord, "wallet", "perception.mirrors"),
      inventory: arrayField(mirrorRecord, "inventory", "perception.mirrors").map(
        (entry, index) =>
          parseItemQty(entry, `perception.mirrors.inventory[${index}]`),
      ),
    },
    tool:
      toolValue === null
        ? null
        : {
            item: stringField(asRecord(toolValue, "perception.tool"), "item", "perception.tool"),
            durability: numberField(
              asRecord(toolValue, "perception.tool"),
              "durability",
              "perception.tool",
            ),
          },
    price_index: arrayField(root, "price_index", "perception").map((entry, index) =>
      parsePriceLine(entry, `perception.price_index[${index}]`),
    ),
    order_book: arrayField(root, "order_book", "perception").map((entry, index) => {
      const record = asRecord(entry, `perception.order_book[${index}]`);
      const side = field(record, "side", `perception.order_book[${index}]`);
      if (side !== "sell" && side !== "buy") {
        throw new TypeError(`perception.order_book[${index}].side must be "sell" or "buy"`);
      }
      return {
        id: numberField(record, "id", `perception.order_book[${index}]`),
        agent_id: stringField(record, "agent_id", `perception.order_book[${index}]`),
        side,
        item: stringField(record, "item", `perception.order_book[${index}]`),
        quantity: quantityField(record, "quantity", `perception.order_book[${index}]`),
        price: quantityField(record, "price", `perception.order_book[${index}]`),
        posted_tick: numberField(record, "posted_tick", `perception.order_book[${index}]`),
        expires_at: numberField(record, "expires_at", `perception.order_book[${index}]`),
      };
    }),
    feedback: arrayField(root, "feedback", "perception").map((entry, index) => {
      if (typeof entry !== "string") {
        throw new TypeError(`perception.feedback[${index}] must be a string`);
      }
      return entry;
    }),
  };
}

export function renderPerception(perception: Perception): string {
  const bodyNote = bodyPerception(perception.body);
  const inventory = perception.mirrors.inventory
    .map((line) => ({ ...line, quantityValue: BigInt(line.quantity) }))
    .filter((line) => line.quantityValue > 0n)
    .map((line) => `${line.item} ×${line.quantity}`)
    .join(", ");
  const board = perception.order_book
    .map((order) => {
      if (order.side === "sell") {
        return `  SELL: ${order.item} ×${order.quantity} at ${order.price}c (by ${order.agent_id}, expires in ${order.expires_at - perception.tick} ticks)`;
      }
      return `  WANT: ${order.item} ×${order.quantity}, paying up to ${order.price}c (${order.agent_id})`;
    })
    .join("\n");
  const feedback = perception.feedback.join("\n");
  const season = perception.season.charAt(0).toUpperCase() + perception.season.slice(1);
  const tool = perception.tool
    ? `${perception.tool.item} (durability ${perception.tool.durability}/100)`
    : "none";

  const lines = [
    `Location: ${perception.location}. ${perception.time}. ${season}, day ${dayOfSeason(perception.tick)}/7.`,
    `Weather: ${perception.weather}`,
    "",
  ];

  if (bodyNote) {
    lines.push(bodyNote, "");
  }

  lines.push(
    `Inventory: ${inventory || "empty"}`,
    `Wallet: ${perception.mirrors.wallet} coin`,
    `Tools: ${tool}`,
    "",
    "Marketplace board:",
    board || "  (no current orders)",
  );

  if (feedback) {
    lines.push("", "Last tick feedback:", feedback);
  }

  return lines.join("\n");
}

export function parseActions(value: unknown): Action[] {
  if (!Array.isArray(value)) {
    throw new TypeError("actions must be an array");
  }

  return value.map((entry, index) => {
    const path = `actions[${index}]`;
    const record = asRecord(entry, path);
    const rawType = field(record, "action_type", path);
    if (typeof rawType !== "string" || !ACTION_TYPES.includes(rawType as ActionType)) {
      throw new TypeError(`${path}.action_type is not a supported action`);
    }

    const action = { action_type: rawType } as Action & Record<string, unknown>;
    const text = optionalString(record, "text", path);
    const item = optionalString(record, "item", path);
    const location = optionalString(record, "location", path);
    const target = optionalString(record, "target", path);
    const quantity = optionalQuantity(record, "quantity", path);
    const price = optionalQuantity(record, "price", path);
    const maxPrice = optionalQuantity(record, "max_price", path);
    const orderId = optionalInteger(record, "order_id", path);
    const side = optionalString(record, "side", path);

    if (text !== undefined) action.text = text;
    if (item !== undefined) action.item = item;
    if (location !== undefined) action.location = location;
    if (target !== undefined) action.target = target;
    if (quantity !== undefined) action.quantity = quantity;
    if (price !== undefined) action.price = price;
    if (maxPrice !== undefined) action.max_price = maxPrice;
    if (orderId !== undefined) action.order_id = orderId;
    if (side !== undefined) {
      if (side !== "sell" && side !== "buy") {
        throw new TypeError(`${path}.side must be "sell" or "buy"`);
      }
      action.side = side;
    }

    if (action.action_type === "move_to" && action.location === undefined) {
      throw new TypeError(`${path}.location is required for move_to`);
    }
    if (
      (action.action_type === "eat" || action.action_type === "produce") &&
      action.item === undefined
    ) {
      throw new TypeError(`${path}.item is required for ${action.action_type}`);
    }
    if (
      action.action_type === "post_order" &&
      (action.item === undefined ||
        action.quantity === undefined ||
        action.price === undefined ||
        action.side === undefined)
    ) {
      throw new TypeError(`${path} needs item, quantity, price, and side for post_order`);
    }
    if (
      action.action_type === "buy_item" &&
      (action.order_id === undefined ||
        action.quantity === undefined ||
        action.max_price === undefined)
    ) {
      throw new TypeError(`${path} needs order_id, quantity, and max_price for buy_item`);
    }
    if (action.action_type === "cancel_order" && action.order_id === undefined) {
      throw new TypeError(`${path}.order_id is required for cancel_order`);
    }
    if (action.action_type === "speak" && action.text === undefined) {
      throw new TypeError(`${path}.text is required for speak`);
    }

    return action;
  });
}

function parseItemQty(value: unknown, path: string): InventoryLine {
  if (Array.isArray(value)) {
    if (value.length !== 2 || typeof value[0] !== "string") {
      throw new TypeError(`${path} must be [item, quantity]`);
    }
    return { item: value[0], quantity: normalizeQuantity(value[1], `${path}[1]`) };
  }
  const record = asRecord(value, path);
  return {
    item: stringField(record, "item", path),
    quantity: quantityField(record, "quantity", path),
  };
}

function parsePriceLine(value: unknown, path: string): PriceLine {
  if (Array.isArray(value)) {
    if (value.length !== 2 || typeof value[0] !== "string") {
      throw new TypeError(`${path} must be [item, price]`);
    }
    return { item: value[0], price: normalizeQuantity(value[1], `${path}[1]`) };
  }
  const record = asRecord(value, path);
  return {
    item: stringField(record, "item", path),
    price: quantityField(record, "price", path),
  };
}

function bodyPerception(body: BodyView): string {
  const parts: string[] = [];
  if (body.hunger >= 4) parts.push("You're very hungry.");
  else if (body.hunger >= 2) parts.push("You're hungry.");
  if (body.energy <= 3) parts.push("You're exhausted.");
  else if (body.energy <= 5) parts.push("You're tired.");
  if (body.sleep_quality <= 50) parts.push("You slept poorly.");
  if (body.sickness >= 2) parts.push("You're seriously ill.");
  else if (body.sickness === 1) parts.push("You're feeling unwell.");
  return parts.length > 0 ? `(${parts.join(" ")})` : "";
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, key: string, path: string): unknown {
  const value = record[key];
  if (value === undefined) {
    throw new TypeError(`${path}.${key} is required`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string, path: string): string {
  const value = field(record, key, path);
  if (typeof value !== "string") {
    throw new TypeError(`${path}.${key} must be a string`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string, path: string): number {
  const value = field(record, key, path);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${path}.${key} must be a safe integer`);
  }
  return value;
}

function quantityField(record: Record<string, unknown>, key: string, path: string): string {
  const value = field(record, key, path);
  return normalizeQuantity(value, `${path}.${key}`);
}

function seasonField(record: Record<string, unknown>, key: string, path: string): Season {
  const value = field(record, key, path);
  if (value !== "spring" && value !== "summer" && value !== "autumn" && value !== "winter") {
    throw new TypeError(`${path}.${key} must be a season`);
  }
  return value;
}

function arrayField(record: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = field(record, key, path);
  if (!Array.isArray(value)) {
    throw new TypeError(`${path}.${key} must be an array`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${path}.${key} must be a string`);
  }
  return value;
}

function optionalQuantity(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return normalizeQuantity(value, `${path}.${key}`);
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError(`${path}.${key} must be a non-negative safe integer`);
}

function normalizeQuantity(value: unknown, path: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value).toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }
  throw new TypeError(`${path} must be a non-negative integer string`);
}
