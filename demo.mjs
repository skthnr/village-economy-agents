import {
  deployEconomy,
  getEconomySnapshot,
  startHarness,
  stopHarness,
} from "./tests/sandbox.ts";
import { runScripted } from "./tests/demo-runner.mjs";

const ticks = Number(process.env.EIDOLON_TICKS ?? 49);

async function main() {
  const harness = await startHarness();
  try {
    const economy = await deployEconomy(harness, "demo");
    console.log(
      `eidolon demo: 19 agents, ${ticks} ticks, zero real funds, scripted policy`,
    );

    const snapshots = [];
    await runScripted(economy, {
      ticks,
      onTick: async (tick) => {
        if (tick % 16 !== 1) return;
        const snapshot = await getEconomySnapshot(economy);
        snapshots.push(snapshot);
        console.log(
          `day ${snapshot.day}: wealth=${snapshot.total_wealth} gini_bps=${snapshot.gini_bps} gdp=${snapshot.gdp} scarce=${snapshot.scarcity_alerts.join(",") || "none"}`,
        );
      },
    });

    console.log(`demo complete: ${snapshots.length} dawn snapshots, ${ticks} ticks`);
  } finally {
    await stopHarness(harness);
  }
}

main().catch((error) => {
  console.error(`demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
