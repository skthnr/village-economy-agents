import {
  actions as nearActions,
  encodeSignedDelegate,
  teraToGas,
  type Account,
  type SignedDelegate,
} from "near-api-js";

import type { Action } from "./perception.js";

const SUBMIT_ACTIONS_GAS = teraToGas(30);
const NO_DEPOSIT = 0n;
const DELEGATE_BLOCK_HEIGHT_TTL = 120;
const RESPONSE_TEXT_LIMIT = 300;

const CORE_ACTION_TYPES: Readonly<Record<string, true>> = {
  move_to: true,
  speak: true,
  produce: true,
  eat: true,
};

export interface RelayResult {
  transactionHash?: string;
  status?: unknown;
}

/**
 * Core actions are the FCK-scoped `submit_actions` payload: they carry no
 * deposit and are the only actions a gasless meta transaction may contain.
 */
export function selectCoreActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => CORE_ACTION_TYPES[action.action_type]);
}

function requireRelayerUrl(): string {
  const url = (process.env.RELAYER_URL ?? "").trim();
  if (url.length === 0) {
    throw new Error("RELAYER_URL is not set; cannot submit core actions through the relayer");
  }
  return url;
}

function parseRelayResult(text: string, url: string): RelayResult {
  if (text.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `relayer ${url} returned a non-JSON response: ${text.slice(0, RESPONSE_TEXT_LIMIT)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `relayer ${url} returned an unexpected response: ${text.slice(0, RESPONSE_TEXT_LIMIT)}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const result: RelayResult = {};
  if (typeof record.transactionHash === "string") {
    result.transactionHash = record.transactionHash;
  }
  if (record.status !== undefined) {
    result.status = record.status;
  }
  return result;
}

/** Posts one base64 borsh-encoded NEP-366 signed delegate to the relayer. */
export async function postSignedDelegate(
  url: string,
  signedDelegate: SignedDelegate,
): Promise<RelayResult> {
  const encoded = Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: encoded }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `relayer ${url} responded ${response.status}: ${text.slice(0, RESPONSE_TEXT_LIMIT)}`,
    );
  }

  return parseRelayResult(text, url);
}

/**
 * Signs a `submit_actions` delegate with the agent's FCK key and relays it.
 * Returns the number of core actions submitted, or 0 when there are none.
 */
export async function submitCoreActionsViaRelayer(
  account: Account,
  worldAccount: string,
  actions: readonly Action[],
): Promise<number> {
  const core = selectCoreActions(actions);
  if (core.length === 0) {
    return 0;
  }

  const url = requireRelayerUrl();
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId: worldAccount,
    actions: [
      nearActions.functionCall(
        "submit_actions",
        { actions: core },
        SUBMIT_ACTIONS_GAS,
        NO_DEPOSIT,
      ),
    ],
    blockHeightTtl: DELEGATE_BLOCK_HEIGHT_TTL,
  });

  await postSignedDelegate(url, signedDelegate);
  return core.length;
}
