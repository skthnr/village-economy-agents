import { nearToYocto, teraToGas } from "near-api-js";

/**
 * One definition of the on-chain call parameters. The orchestrator, the
 * relayer client, and the near-sandbox test harness import these values so
 * every caller sends identical gas and deposit amounts.
 */
export const WORLD_CALL_GAS = teraToGas(30);
export const TOKEN_CALL_GAS = teraToGas(100);
export const BUY_CALL_GAS = teraToGas(160);
export const CANCEL_CALL_GAS = teraToGas(60);
export const RUN_TICK_GAS = teraToGas(600);
export const NO_DEPOSIT = 0n;
export const ONE_YOCTO = 1n;
export const ONE_NEAR = nearToYocto("1");
export const TEN_MILLI_NEAR = nearToYocto("0.01");
export const ITEM_DEPOSIT = 1n;
export const ORDER_DEPOSIT = TEN_MILLI_NEAR;

/** FCK-scoped actions accepted by `submit_actions`. */
export const CORE_ACTION_TYPES: Readonly<Record<string, true>> = { move_to: true, speak: true, produce: true, eat: true };
