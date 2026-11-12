import {
  deployEconomy,
  startHarness,
  stopHarness,
} from "../tests/sandbox.ts";
import { runScripted } from "../tests/demo-runner.mjs";

const ticks = Number(process.env.EIDOLON_TICKS ?? 49);

function gasBurnt(outcome) {
  const receipts = outcome?.receipts_outcome ?? [];
  return receipts.reduce(
    (total, receipt) => total + BigInt(String(receipt?.outcome?.gas_burnt ?? 0)),
    0n,
  );
}

async function main() {
  const harness = await startHarness();
  try {
    const economy = await deployEconomy(harness, "measure");
    const { outcomes, elapsedMs } = await runScripted(economy, { ticks });

    const totalGas = outcomes.reduce((total, outcome) => total + gasBurnt(outcome), 0n);
    const perTick = Number(totalGas) / Number(ticks);
    const tgasPerTick = perTick / 1e12;
    const date = new Date().toISOString().slice(0, 10);

    let storage = 0;
    for (const accountId of [economy.ids.world, economy.ids.items, economy.ids.coin]) {
      const view = await harness.provider.viewAccount({ accountId });
      storage += Number(view.storage_usage);
    }

    console.log(
      `${ticks} ticks in ${(elapsedMs / 1000).toFixed(2)}s; ${tgasPerTick.toFixed(2)} Tgas/tick (ubuntu-latest, ${date})`,
    );
    console.log(`storage: ${storage} bytes across world/items/coin`);
  } finally {
    await stopHarness(harness);
  }
}

main().catch((error) => {
  console.error(`measure failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
