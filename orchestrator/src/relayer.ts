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


/**
 * Core actions are the FCK-scoped `submit_actions` payload: they carry no
 * deposit and are the only actions a gasless meta transaction may contain.
 */
export function selectCoreActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => CORE_ACTION_TYPES[action.action_type]);
}



/** Posts one base64 borsh-encoded NEP-366 signed delegate to the relayer. */
export async function postSignedDelegate(
  url: string,
  signedDelegate: SignedDelegate,
): Promise<void> {
  const encoded = Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: encoded }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `relayer ${url} responded ${response.status}: ${text.slice(0, RESPONSE_TEXT_LIMIT)}`,
    );
  }
}

/**
 * Signs a `submit_actions` delegate with the agent's FCK key and relays it.
 * Returns the number of core actions submitted, or 0 when there are none.
 */
export async function submitCoreActionsViaRelayer(
  account: Account,
  worldAccount: string,
  url: string,
  actions: readonly Action[],
): Promise<number> {
  const core = selectCoreActions(actions);
  if (core.length === 0) {
    return 0;
  }

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
