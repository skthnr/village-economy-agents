import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions as nearActions,
  teraToGas,
  type KeyPairString,
} from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";

import { AGENT_ORDER } from "../orchestrator/src/policy-agents.js";
import type { Action, OrderView } from "../orchestrator/src/perception.js";
import {
  BUY_CALL_GAS,
  CORE_ACTION_TYPES,
  ITEM_DEPOSIT,
  ONE_NEAR,
  ORDER_DEPOSIT,
  RUN_TICK_GAS,
  TEN_MILLI_NEAR,
  TOKEN_CALL_GAS,
  WORLD_CALL_GAS,
} from "../orchestrator/src/constants.js";

export type ContractName = "world" | "items" | "coin";

export interface SeedAgentProfile {
  skill: string;
  home: string;
  work: string;
  work_start: number;
  work_end: number;
  wallet: number;
  inventory: [string, number][];
  tool: string | null;
  tool_durability: number;
}

export interface SeedAgent {
  name: string;
  profile: SeedAgentProfile;
}

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Single source: the 19 seed agents used by deploy and tests. */
export const SEED_AGENTS: readonly SeedAgent[] = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "scripts/seeds.json"), "utf8"),
) as readonly SeedAgent[];
const WASM_FILES: Readonly<Record<ContractName, string>> = {
  world: "eidolon_world.wasm",
  items: "eidolon_items.wasm",
  coin: "eidolon_coin.wasm",
};

export interface ContractWasm {
  world: Uint8Array;
  items: Uint8Array;
  coin: Uint8Array;
}

export interface Harness {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  master: Account;
  wasm: ContractWasm;
}

export interface AgentHandle {
  name: string;
  accountId: string;
  fckKeys: KeyPair;
  marketKeys: KeyPair;
  /** Gas-only function-call key scoped to `world::submit_actions`. */
  fckAccount: Account;
  /** Full-access key used for items/coin/world market calls. */
  marketAccount: Account;
}

export interface ContractIds {
  world: string;
  items: string;
  coin: string;
}

export interface Economy {
  tag: string;
  ids: ContractIds;
  accounts: Record<ContractName, Account>;
  agents: Map<string, AgentHandle>;
  harness: Harness;
}

export interface WorldViewBody {
  hunger: number;
  energy: number;
  sleep_quality: number;
  sickness: number;
  starvation_ticks: number;
}

export interface WorldView {
  tick: number;
  time: string;
  weather: string;
  season: string;
  day_of_season: number;
  locations: [string, string][];
  bodies: [string, WorldViewBody][];
  last_snapshot: Record<string, unknown>;
}

function wasmCandidatePaths(name: ContractName): string[] {
  const file = WASM_FILES[name];
  const crate = `eidolon_${name}`;
  return [
    resolve(REPO_ROOT, "target/near", crate, file),
    resolve(REPO_ROOT, "contracts", name, "target/near", crate, file),
    resolve(REPO_ROOT, "target/near", file),
    resolve(REPO_ROOT, "contracts", name, "target/near", file),
    resolve(REPO_ROOT, "contracts", name, "target/wasm32-unknown-unknown/release", file),
    resolve(REPO_ROOT, "target/wasm32-unknown-unknown/release", file),
  ];
}

export function loadContractWasm(name: ContractName): Uint8Array {
  const candidates = wasmCandidatePaths(name);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate);
    }
  }
  throw new Error(
    `missing ${WASM_FILES[name]}; looked in:\n${candidates.join("\n")}\n` +
      `build it first: (cd contracts/${name} && cargo near build non-reproducible-wasm)`,
  );
}

export async function startHarness(): Promise<Harness> {
  // Fail before downloading/starting the sandbox when the contracts are not built.
  const wasm: ContractWasm = {
    world: loadContractWasm("world"),
    items: loadContractWasm("items"),
    coin: loadContractWasm("coin"),
  };
  killAllSandboxes();
  const sandbox = await Sandbox.start({});
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }, { retries: 10 });
    const masterKey = KeyPair.fromString(DEFAULT_PRIVATE_KEY as KeyPairString);
    const master = new Account(
      DEFAULT_ACCOUNT_ID,
      provider,
      new KeyPairSigner(masterKey),
    );
    return { sandbox, provider, master, wasm };
  } catch (error) {
    await sandbox.tearDown().catch(async () => {
      await sandbox.stop().catch(() => undefined);
    });
    throw error;
  }
}

function killAllSandboxes(): void {
  for (const signal of ["-TERM", "-KILL"]) {
    try {
      execFileSync("pkill", [signal, "-f", "near-sandbox/bin/near-sandbox"], {
        stdio: "ignore",
      });
    } catch {
      // Nothing to clean.
    }
  }
}

function killSandboxProcess(homeDir: string): void {
  for (const signal of ["-TERM", "-KILL"]) {
    try {
      execFileSync("pkill", [signal, "-f", `near-sandbox.*${homeDir}`], {
        stdio: "ignore",
      });
    } catch {
      // pkill returns non-zero when no process matched; the sandbox is gone.
    }
  }
}

export async function stopHarness(harness: Harness): Promise<void> {
  const homeDir = harness.sandbox.homeDir;
  killSandboxProcess(homeDir);
  const { promise: timeout, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 5_000);
  await Promise.race([harness.sandbox.stop().catch(() => undefined), timeout]);
  killSandboxProcess(homeDir);
}

function economyAccountId(role: "world" | "items" | "coin", tag: string): string {
  return `${role}${tag}.${DEFAULT_ACCOUNT_ID}`;
}

function seedNameMatch(): void {
  if (SEED_AGENTS.length !== AGENT_ORDER.length) {
    throw new Error(
      `seed agents (${SEED_AGENTS.length}) do not match AGENT_ORDER (${AGENT_ORDER.length})`,
    );
  }
  for (const [index, name] of AGENT_ORDER.entries()) {
    if (SEED_AGENTS[index]?.name !== name) {
      throw new Error(`seed agents must match AGENT_ORDER at index ${index}: ${name}`);
    }
  }
}

async function createDeployer(
  harness: Harness,
  accountId: string,
): Promise<Account> {
  const keyPair = KeyPair.fromRandom("ed25519");
  await harness.master.createAccount({
    newAccountId: accountId,
    publicKey: keyPair.getPublicKey(),
    nearToTransfer: ONE_NEAR,
  });
  await harness.master.signAndSendTransaction({
    receiverId: accountId,
    actions: [nearActions.transfer(20n * ONE_NEAR)],
    waitUntil: "FINAL",
  });
  return new Account(accountId, harness.provider, new KeyPairSigner(keyPair));
}

async function deployAndInit(
  account: Account,
  wasm: Uint8Array,
  initArgs: Record<string, unknown>,
  gasTera: number,
): Promise<void> {
  await account.signAndSendTransaction({
    receiverId: account.accountId,
    actions: [nearActions.deployContract(wasm)],
    waitUntil: "EXECUTED",
  });
  await account.callFunction({
    contractId: account.accountId,
    methodName: "new",
    args: initArgs,
    gas: teraToGas(gasTera),
    deposit: 0n,
    waitUntil: "EXECUTED",
  });
}


export function requireAgent(economy: Economy, name: string): AgentHandle {
  const agent = economy.agents.get(name);
  if (agent === undefined) {
    throw new Error(`unknown agent ${name} in economy ${economy.tag}`);
  }
  return agent;
}

export async function deployEconomy(
  harness: Harness,
  tag: string,
): Promise<Economy> {
  if (!/^[a-z0-9]+$/.test(tag)) {
    throw new Error(`economy tag must be lowercase alphanumeric, got ${tag}`);
  }
  seedNameMatch();

  const ids: ContractIds = {
    world: economyAccountId("world", tag),
    items: economyAccountId("items", tag),
    coin: economyAccountId("coin", tag),
  };
  const accounts: Record<ContractName, Account> = {
    world: await createDeployer(harness, ids.world),
    items: await createDeployer(harness, ids.items),
    coin: await createDeployer(harness, ids.coin),
  };

  await Promise.all([
    deployAndInit(
      accounts.items,
      harness.wasm.items,
      { owner_id: ids.world },
      150,
    ),
    deployAndInit(
      accounts.coin,
      harness.wasm.coin,
      {
        owner_id: ids.world,
        total_supply: "1000000",
        metadata: {
          spec: "ft-1.0.0",
          name: "eidolon coin",
          symbol: "COIN",
          decimals: 0,
        },
      },
      150,
    ),
    deployAndInit(
      accounts.world,
      harness.wasm.world,
      {
        items_contract: ids.items,
        coin_contract: ids.coin,
        seed_agents: SEED_AGENTS,
      },
      300,
    ),
  ]);

  // Test-harness funding only; no contract logic changes here. The world
  // factory `create_agent_with_keys` creates one sub-account per seed agent and
  // transfers ~20.0025 NEAR out of the world balance for each (10 N
  // AGENT_CREATION_TRANSFER + 10 N AGENT_ITEMS_DEPOSIT + 0.0025 N coin storage).
  // 19 agents therefore need ~380 N, but `createDeployer` starts the world with
  // only 21 N; without this top-up the second agent creation fails with
  // "Exceeded the account balance". Fund the world for all 19 agents plus
  // register_world storage and gas, with headroom.
  await harness.master.signAndSendTransaction({
    receiverId: ids.world,
    actions: [nearActions.transfer(400n * ONE_NEAR)],
    waitUntil: "FINAL",
  });

  await accounts.world.callFunction({
    contractId: ids.world,
    methodName: "register_world",
    args: {},
    gas: teraToGas(300),
    deposit: 0n,
    waitUntil: "FINAL",
  });

  const agentKeys = new Map<string, { fck: KeyPair; market: KeyPair }>();
  for (const seed of SEED_AGENTS) {
    agentKeys.set(seed.name, {
      fck: KeyPair.fromRandom("ed25519"),
      market: KeyPair.fromRandom("ed25519"),
    });
  }

  for (const seed of SEED_AGENTS) {
    const keys = agentKeys.get(seed.name);
    if (keys === undefined) throw new Error(`missing keys for ${seed.name}`);
    await accounts.world.callFunction({
      contractId: ids.world,
      methodName: "create_agent_with_keys",
      args: {
        name: seed.name,
        fck_public_key: keys.fck.getPublicKey().toString(),
        market_public_key: keys.market.getPublicKey().toString(),
      },
      gas: teraToGas(300),
      deposit: TEN_MILLI_NEAR,
      waitUntil: "FINAL",
    });
  }

  // The factory transfers 10 mNEAR per agent; fund each market key so the
  // full-access transactions in the simulation can pay gas.
  for (const seed of SEED_AGENTS) {
    await harness.master.signAndSendTransaction({
      receiverId: `${seed.name}.${ids.world}`,
      actions: [nearActions.transfer(10n * ONE_NEAR)],
      waitUntil: "FINAL",
    });
  }

  const agents = new Map<string, AgentHandle>();
  for (const seed of SEED_AGENTS) {
    const keys = agentKeys.get(seed.name);
    if (keys === undefined) throw new Error(`missing keys for ${seed.name}`);
    const accountId = `${seed.name}.${ids.world}`;
    agents.set(seed.name, {
      name: seed.name,
      accountId,
      fckKeys: keys.fck,
      marketKeys: keys.market,
      fckAccount: new Account(
        accountId,
        harness.provider,
        new KeyPairSigner(keys.fck),
      ),
      marketAccount: new Account(
        accountId,
        harness.provider,
        new KeyPairSigner(keys.market),
      ),
    });
  }

  const economy: Economy = {
    tag,
    ids,
    accounts,
    agents,
    harness,
  };

  const view = await viewWorld(economy);
  if (view.tick !== 1) {
    throw new Error(`world ${ids.world} did not initialize at tick 1`);
  }
  return economy;
}

function asSerializedValue(value: unknown): string | number | boolean | object {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "object"
  ) {
    return value as string | number | boolean | object;
  }
  throw new Error(`unexpected view return value: ${String(value)}`);
}

export async function view<T = unknown>(
  economy: Economy,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await economy.harness.provider.callFunction({
    contractId,
    method,
    args,
  });
  if (result === undefined) {
    throw new Error(`view ${method} on ${contractId} returned no value`);
  }
  return asSerializedValue(result) as T;
}

function toBigInt(value: unknown, label: string): bigint {
  if (value === null || value === undefined) return 0n;
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label}: expected an unsigned integer, got ${text}`);
  }
  return BigInt(text);
}

export async function getPerception(
  economy: Economy,
  agentId: string,
): Promise<string> {
  const value = await view<string>(economy, economy.ids.world, "get_perception", {
    agent_id: agentId,
  });
  if (typeof value !== "string") {
    throw new Error(`get_perception(${agentId}) did not return a JSON string`);
  }
  return value;
}

export async function getOrderBook(
  economy: Economy,
  agentId: string,
): Promise<OrderView[]> {
  return view<OrderView[]>(economy, economy.ids.world, "get_order_book", {
    agent_id: agentId,
  });
}

export async function viewWorld(economy: Economy): Promise<WorldView> {
  return view<WorldView>(economy, economy.ids.world, "get_world_view");
}

export async function getEconomySnapshot(
  economy: Economy,
): Promise<Record<string, unknown>> {
  return view<Record<string, unknown>>(
    economy,
    economy.ids.world,
    "get_economy_snapshot",
  );
}

export async function mtBalanceOf(
  economy: Economy,
  accountId: string,
  tokenId: string,
): Promise<bigint> {
  const value = await view<unknown>(economy, economy.ids.items, "mt_balance_of", {
    account_id: accountId,
    token_id: tokenId,
  });
  return toBigInt(value, `mt_balance_of(${accountId}, ${tokenId})`);
}

export async function mtSupply(
  economy: Economy,
  tokenId: string,
): Promise<bigint> {
  const value = await view<unknown>(economy, economy.ids.items, "mt_supply", {
    token_id: tokenId,
  });
  return toBigInt(value, `mt_supply(${tokenId})`);
}

export async function ftBalanceOf(
  economy: Economy,
  accountId: string,
): Promise<bigint> {
  const value = await view<unknown>(economy, economy.ids.coin, "ft_balance_of", {
    account_id: accountId,
  });
  return toBigInt(value, `ft_balance_of(${accountId})`);
}

export async function submitCoreActions(
  economy: Economy,
  agent: AgentHandle,
  actions: readonly Action[],
): Promise<number> {
  const core = actions.filter(
    (action) => CORE_ACTION_TYPES[action.action_type] === true,
  );
  if (core.length === 0) return 0;
  await agent.fckAccount.callFunction({
    contractId: economy.ids.world,
    methodName: "submit_actions",
    args: { actions: core },
    gas: WORLD_CALL_GAS,
    deposit: 0n,
    waitUntil: "EXECUTED",
  });
  return core.length;
}

export interface MarketCallOptions {
  gas?: bigint;
  deposit?: bigint;
}

export async function marketCall(
  economy: Economy,
  agent: AgentHandle,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  options: MarketCallOptions = {},
): Promise<void> {
  await agent.marketAccount.callFunction({
    contractId,
    methodName,
    args,
    gas: options.gas ?? TOKEN_CALL_GAS,
    deposit: options.deposit ?? 0n,
    waitUntil: "FINAL",
  });
}

export async function postSellOrder(
  economy: Economy,
  agent: AgentHandle,
  item: string,
  quantity: bigint,
  price: bigint,
): Promise<void> {
  await marketCall(economy, agent, economy.ids.items, "mt_transfer_call", {
    receiver_id: economy.ids.world,
    token_id: item,
    amount: quantity.toString(),
    approval: null,
    memo: null,
    msg: `sell:${price.toString()}`,
  }, { deposit: ITEM_DEPOSIT });
}

export async function postBuyOrder(
  economy: Economy,
  agent: AgentHandle,
  item: string,
  quantity: bigint,
  price: bigint,
): Promise<void> {
  await marketCall(economy, agent, economy.ids.world, "post_order", {
    item,
    quantity: quantity.toString(),
    price: price.toString(),
  }, { deposit: ORDER_DEPOSIT });
}

export async function buyOrder(
  economy: Economy,
  agent: AgentHandle,
  orderId: number,
  maxPrice: bigint,
  quantity: bigint,
): Promise<void> {
  await marketCall(economy, agent, economy.ids.coin, "ft_transfer_call", {
    receiver_id: economy.ids.world,
    amount: (maxPrice * quantity).toString(),
    memo: null,
    msg: `buy:${orderId}:${maxPrice.toString()}`,
  }, { deposit: ITEM_DEPOSIT, gas: BUY_CALL_GAS });
}

export async function cancelOrder(
  economy: Economy,
  agent: AgentHandle,
  orderId: number,
): Promise<void> {
  await marketCall(economy, agent, economy.ids.world, "cancel_order", {
    order_id: orderId,
  });
}

export async function mtTransfer(
  economy: Economy,
  from: AgentHandle,
  receiverId: string,
  tokenId: string,
  amount: bigint,
): Promise<void> {
  await marketCall(economy, from, economy.ids.items, "mt_transfer", {
    receiver_id: receiverId,
    token_id: tokenId,
    amount: amount.toString(),
    approval: null,
    memo: null,
  }, { deposit: ITEM_DEPOSIT });
}

export async function executeTick(economy: Economy) {
  return economy.accounts.world.callFunctionRaw({
    contractId: economy.ids.world,
    methodName: "run_tick",
    args: {},
    gas: RUN_TICK_GAS,
    deposit: 0n,
    waitUntil: "FINAL",
  });
}

export function isMarketAction(action: Action): boolean {
  return (
    action.action_type === "post_order" ||
    action.action_type === "buy_item" ||
    action.action_type === "cancel_order"
  );
}

export async function executeMarketAction(
  economy: Economy,
  agent: AgentHandle,
  action: Action,
): Promise<void> {
  if (action.action_type === "post_order") {
    const quantity = BigInt(action.quantity);
    const price = BigInt(action.price);
    if (action.side === "sell") {
      await postSellOrder(economy, agent, action.item, quantity, price);
      return;
    }
    if (action.side === "buy") {
      await postBuyOrder(economy, agent, action.item, quantity, price);
      return;
    }
    throw new Error(`post_order needs a side, got ${String(action.side)}`);
  }
  if (action.action_type === "buy_item") {
    await buyOrder(
      economy,
      agent,
      action.order_id,
      BigInt(action.max_price),
      BigInt(action.quantity),
    );
    return;
  }
  if (action.action_type === "cancel_order") {
    await cancelOrder(economy, agent, action.order_id);
    return;
  }
  throw new Error(`not a market action: ${action.action_type}`);
}

export function findOrder(
  orders: readonly OrderView[],
  predicate: (order: OrderView) => boolean,
): OrderView {
  const order = orders.find(predicate);
  if (order === undefined) {
    throw new Error("expected order was not found in the order book");
  }
  return order;
}

