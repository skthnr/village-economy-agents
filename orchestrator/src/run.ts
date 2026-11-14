import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
} from "near-api-js";

import {
  BUY_CALL_GAS,
  CANCEL_CALL_GAS,
  NO_DEPOSIT,
  ONE_YOCTO,
  ORDER_DEPOSIT,
  RUN_TICK_GAS,
  TOKEN_CALL_GAS,
  WORLD_CALL_GAS,
} from "./constants.js";
import { ensureAgentKeys } from "./keys.js";
import { ACTION_TOOLS, decideWithLlm } from "./llm.js";
import { parsePerception, renderPerception, type Action } from "./perception.js";
import {
  AGENT_ORDER,
  decideActions,
  resolvePolicyMode,
  type PolicyMode,
} from "./policy-agents.js";
import { relayCoreActions, selectCoreActions } from "./relayer.js";

const DEFAULT_TICKS = 112;

interface RunConfig {
  worldAccount: string;
  itemsAccount: string;
  coinAccount: string;
  rpcUrl: string;
  ownerKey: string;
  ticks: number;
  policy: PolicyMode;
  relayerUrl: string | undefined;
  hasAiKey: boolean;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  const provider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 3 });
  const ownerKeyPair = KeyPair.fromString(config.ownerKey as KeyPairString);
  const owner = new Account(config.worldAccount, provider, new KeyPairSigner(ownerKeyPair));
  const keys = await ensureAgentKeys(AGENT_ORDER);
  const fckAccounts = new Map<string, Account>();
  const marketAccounts = new Map<string, Account>();

  for (const name of AGENT_ORDER) {
    const agentKeys = keys.get(name);
    if (agentKeys === undefined) {
      throw new Error(`keystore did not return keys for ${name}`);
    }
    const accountId = npcAccountId(name, config.worldAccount);
    fckAccounts.set(name, new Account(accountId, provider, new KeyPairSigner(agentKeys.fck)));
    marketAccounts.set(
      name,
      new Account(accountId, provider, new KeyPairSigner(agentKeys.market)),
    );
  }

  let processed = 0;
  while (processed < config.ticks) {
    let submitted = 0;

    const mode = resolvePolicyMode(config.policy, config.hasAiKey);
    const perceptions = await Promise.all(
      AGENT_ORDER.map(async (name) => {
        const agentId = npcAccountId(name, config.worldAccount);
        const perception = parsePerception(
          await callView<string>(provider, config.worldAccount, "get_perception", {
            agent_id: agentId,
          }),
        );
        return { name, perception };
      }),
    );

    const decided: { name: string; fckAccount: Account; marketAccount: Account; actions: Action[] }[] = [];
    for (const { name, perception } of perceptions) {
      const actions =
        mode === "llm"
          ? await decideWithLlm(renderPerception(perception), ACTION_TOOLS)
          : decideActions(name, perception);
      const fckAccount = fckAccounts.get(name);
      const marketAccount = marketAccounts.get(name);
      if (fckAccount === undefined || marketAccount === undefined) {
        throw new Error(`missing signer account for ${name}`);
      }
      decided.push({ name, fckAccount, marketAccount, actions });
    }

    for (const entry of decided) {
      submitted += await executeOrderActions(entry.marketAccount, config, entry.actions);
    }

    const coreCounts = await Promise.all(
      decided.map((entry) => submitActions(entry.fckAccount, config, entry.actions)),
    );
    for (const count of coreCounts) submitted += count;
    await owner.callFunction({
      contractId: config.worldAccount,
      methodName: "run_tick",
      args: {},
      gas: RUN_TICK_GAS,
      deposit: NO_DEPOSIT,
    });

    processed += 1;
    const tick = perceptions[0]?.perception.tick ?? processed;
    console.log(`tick ${tick}: submitted ${submitted} actions`);
  }

  const snapshot = await callView<Record<string, unknown>>(
    provider,
    config.worldAccount,
    "get_economy_snapshot",
    {},
  );
  console.log(JSON.stringify(snapshot));
}

function loadConfig(argv: readonly string[]): RunConfig {
  let ticks = Number(process.env.TICKS ?? DEFAULT_TICKS);
  let policy: PolicyMode = "auto";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") {
      ticks = 1;
    } else if (argument === "--ticks") {
      ticks = parseTicks(argv[index + 1]);
      index += 1;
    } else if (argument === "--policy") {
      policy = parsePolicyMode(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${argument}; use --ticks N, --once, or --policy auto|policy|llm`,
      );
    }
  }

  if (!Number.isSafeInteger(ticks) || ticks < 1) {
    throw new Error("ticks must be a positive integer");
  }

  const relayerUrl = (process.env.RELAYER_URL ?? "").trim();
  return {
    worldAccount: requireEnv("WORLD_ACCOUNT"),
    itemsAccount: requireEnv("ITEMS_ACCOUNT"),
    coinAccount: requireEnv("COIN_ACCOUNT"),
    rpcUrl: requireEnv("NEAR_RPC_URL"),
    ownerKey: requireEnv("WORLD_OWNER_KEY"),
    ticks,
    policy,
    relayerUrl: relayerUrl.length === 0 ? undefined : relayerUrl,
    hasAiKey: (process.env.NEAR_AI_API_KEY ?? "").length > 0,
  };
}

function parseTicks(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error("--ticks needs a positive integer");
  }
  return Number(value);
}

function parsePolicyMode(value: string | undefined): PolicyMode {
  if (value === "auto" || value === "policy" || value === "llm") {
    return value;
  }
  throw new Error("--policy must be auto, policy, or llm");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `missing ${name}; copy .env.example to .env and set ${name} before running the orchestrator`,
    );
  }
  return value.trim();
}

function npcAccountId(name: string, worldAccount: string): string {
  return `${name}.${worldAccount}`;
}

async function callView<T>(
  provider: JsonRpcProvider,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await provider.callFunction({ contractId, method, args });
  if (result === undefined) {
    throw new Error(`view call ${method} on ${contractId} returned no value`);
  }
  const decoded: unknown = result;
  return decoded as T;
}

async function submitActions(
  account: Account,
  config: RunConfig,
  actions: readonly Action[],
): Promise<number> {
  if (config.relayerUrl !== undefined) {
    return relayCoreActions(account, config.worldAccount, config.relayerUrl, actions);
  }

  const core = selectCoreActions(actions);
  if (core.length === 0) return 0;
  await account.callFunction({
    contractId: config.worldAccount,
    methodName: "submit_actions",
    args: { actions: core },
    gas: WORLD_CALL_GAS,
    deposit: NO_DEPOSIT,
  });
  return core.length;
}

async function executeOrderActions(
  account: Account,
  config: RunConfig,
  actions: readonly Action[],
): Promise<number> {
  let submitted = 0;

  for (const action of actions) {
    if (action.action_type === "post_order") {
      if (action.side === "buy") {
        await account.callFunction({
          contractId: config.worldAccount,
          methodName: "post_order",
          args: { item: action.item, quantity: action.quantity, price: action.price },
          gas: WORLD_CALL_GAS,
          deposit: ORDER_DEPOSIT,
        });
      } else {
        await account.callFunction({
          contractId: config.itemsAccount,
          methodName: "mt_transfer_call",
          args: {
            receiver_id: config.worldAccount,
            token_id: action.item,
            amount: action.quantity,
            approval: null,
            memo: null,
            msg: `sell:${action.price}`,
          },
          gas: TOKEN_CALL_GAS,
          deposit: ONE_YOCTO,
        });
      }
      submitted += 1;
    } else if (action.action_type === "buy_item") {
      await account.callFunction({
        contractId: config.coinAccount,
        methodName: "ft_transfer_call",
        args: {
          receiver_id: config.worldAccount,
          amount: (BigInt(action.max_price) * BigInt(action.quantity)).toString(),
          memo: null,
          msg: `buy:${action.order_id}:${action.max_price}`,
        },
        gas: BUY_CALL_GAS,
        deposit: ONE_YOCTO,
      });
      submitted += 1;
    } else if (action.action_type === "cancel_order") {
      await account.callFunction({
        contractId: config.worldAccount,
        methodName: "cancel_order",
        args: { order_id: action.order_id },
        gas: CANCEL_CALL_GAS,
        deposit: NO_DEPOSIT,
      });
      submitted += 1;
    }
  }

  return submitted;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`orchestrator failed: ${message}`);
  process.exitCode = 1;
});
