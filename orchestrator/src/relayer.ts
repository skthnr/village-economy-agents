import {
  actions as nearActions,
  encodeSignedDelegate,
  type Account,
  type SignedDelegate,
} from "near-api-js";

import { CORE_ACTION_TYPES, NO_DEPOSIT, WORLD_CALL_GAS } from "./constants.js";
import type { Action } from "./perception.js";

const DELEGATE_TTL_BLOCKS = 120;
const RESPONSE_TEXT_LIMIT = 300;


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
  const encoded = encodeSignedDelegate(signedDelegate).toBase64();
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
export async function relayCoreActions(
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
        WORLD_CALL_GAS,
        NO_DEPOSIT,
      ),
    ],
    blockHeightTtl: DELEGATE_TTL_BLOCKS,
  });

  await postSignedDelegate(url, signedDelegate);
  return core.length;
}
