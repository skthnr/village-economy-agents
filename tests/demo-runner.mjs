import { parsePerception } from "../orchestrator/src/perception.ts";
import { AGENT_ORDER, decideActions } from "../orchestrator/src/policy-agents.ts";
import {
  executeMarketAction,
  executeTick,
  getPerception,
  isMarketAction,
  requireAgent,
  submitCoreActions,
} from "./sandbox.ts";

/**
 * Scripted-agent loop shared by the demo and the measurement.
 * Zero real funds: all accounts are local near-sandbox accounts.
 */
export async function runScripted(economy, { ticks, onTick, marketEvery = 16 } = {}) {
  const horizon = ticks ?? 49;
  const started = performance.now();
  const outcomes = [];

  for (let tick = 1; tick <= horizon; tick += 1) {
    const decisions = await Promise.all(
      AGENT_ORDER.map(async (name) => {
        const agent = requireAgent(economy, name);
        const perception = parsePerception(
          await getPerception(economy, agent.accountId),
        );
        return { name, agent, perception, actions: decideActions(name, perception) };
      }),
    );

    const marketTick = marketEvery > 0 && (tick - 1) % marketEvery === 0;
    for (const decision of decisions) {
      if (!marketTick) break;
      for (const action of decision.actions) {
        if (!isMarketAction(action)) continue;
        try {
          await executeMarketAction(economy, decision.agent, action);
        } catch (error) {
          if (action.action_type !== "buy_item") throw error;
        }
      }
    }

    await Promise.all(
      decisions.map((decision) =>
        submitCoreActions(economy, decision.agent, decision.actions),
      ),
    );

    outcomes.push(await executeTick(economy));
    if (onTick !== undefined) {
      await onTick(tick, economy);
    }
    if (tick % 10 === 0) {
      console.log(`${economy.tag}: tick ${tick}/${horizon}`);
    }
  }

  return { outcomes, elapsedMs: performance.now() - started };
}
