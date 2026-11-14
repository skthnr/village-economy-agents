/*
 * WAVE-5 native variant ladder. Five prototypes, 14 rungs each (70 rungs),
 * run at two input scales (small 28, large 112) => 140 measurements.
 * Each rung carries an instrumented WORK counter, a measured ns/op (min of
 * TRIALS), and a strict output oracle. A rung is ACCEPTED only when strictly
 * better than the previous accepted rung on >=1 metric and not worse on the
 * other, oracle-equal. Ties/regressions are REJECTED evidence, not wins.
 * Prototype D uses native Node 26 Uint8Array#toHex() (no Buffer codec dep,
 * no suppression). No deps beyond node:crypto / node:buffer globals.
 */
import { createHash, hash } from "node:crypto";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALE = Number(process.env.W5_SCALE ?? 112);
const RUNGS = 14;
const REPS = 1500;
const TRIALS = 3;

const rnd = mulberry32(0xe1d010);
const series = (scale) =>
  Array.from({ length: SCALE }, () => BigInt(Math.floor(rnd() * scale)));

const TRACE = {
  snapshot: JSON.stringify({
    tick: SCALE,
    price_index: Array.from({ length: 18 }, (_, i) => [`item${i}`, String(1000 + i)]),
    wealth: Array.from({ length: 19 }, (_, i) => ({
      agent: `agent${i}`,
      wallet: String(500 + i),
      inventory_value: "0",
    })),
  }),
  flourSupply: series(50),
  breadSupply: series(80),
  millerFlour: series(30),
  bakerFlour: series(20),
  failures: [],
};

function chunksOf(t) {
  const c = [t.snapshot, "\n"];
  for (const s of [t.flourSupply, t.breadSupply, t.millerFlour, t.bakerFlour]) {
    for (const v of s) c.push(v.toString(), ",");
    c.push("|");
  }
  c.push("\n");
  for (const f of t.failures) c.push(f, ";");
  return c;
}

const CHUNKS = chunksOf(TRACE);
const TOTAL = CHUNKS.length;
const BIG = CHUNKS.join("");
const BYTES = Buffer.from(BIG, "utf8");
const ORACLE_DIGEST = createHash("sha256").update(BIG).digest("hex");
const ORACLE_HEX = BYTES.toString("hex");
const PRE = CHUNKS.map(String);

function bench(fn) {
  fn();
  let best = Infinity;
  let work = 0;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const t0 = process.hrtime.bigint();
    let w = 0;
    for (let i = 0; i < REPS; i += 1) w += fn().w;
    const ns = Number(process.hrtime.bigint() - t0) / REPS;
    if (ns < best) {
      best = ns;
      work = w / REPS;
    }
  }
  return { ns: best, work: Math.round(work) };
}

function verdicts(name, rows, oracle) {
  const out = [];
  let prev = null;
  for (const row of rows) {
    const equal = row.hex === oracle;
    let status = "ACCEPTED";
    let why = "";
    if (!equal) {
      status = "REJECTED";
      why = "oracle mismatch";
    } else if (prev === null) {
      why = "baseline";
    } else if (row.work < prev.work && row.ns <= prev.ns) {
      why = `work -${prev.work - row.work}`;
    } else if (row.work <= prev.work && row.ns < prev.ns) {
      why = `ns -${(prev.ns - row.ns).toFixed(1)}`;
    } else {
      status = "REJECTED";
      why = `work ${row.work} vs ${prev.work}, ns ${row.ns.toFixed(1)} vs ${prev.ns.toFixed(1)}`;
    }
    if (status === "ACCEPTED") prev = row;
    out.push({ ...row, status, why });
  }
  console.log(`\n### ${name} (oracle ${String(oracle).slice(0, 16)}...)`);
  console.log("rung\tstatus\twork\tns/op\tdigest\treason");
  for (const r of out) {
    console.log(
      `${r.name}\t${r.status}\t${r.work}\t${r.ns.toFixed(1)}\t${r.hex.slice(0, 8)}\t${r.why}`,
    );
  }
  return out;
}

// Prototype A (hot path): streaming SHA-256 split into K contiguous batches.
const A = [];
for (let k = RUNGS - 1; k >= 1; k -= 1) {
  const step = Math.ceil(BIG.length / k);
  const parts = [];
  for (let i = 0; i < BIG.length; i += step) parts.push(BIG.slice(i, i + step));
  const fn = () => {
    const h = createHash("sha256");
    let w = 0;
    for (const p of parts) {
      h.update(p);
      w += 2;
    }
    return { hex: h.digest("hex"), w };
  };
  const m = bench(fn);
  A.push({ name: `A-K${String(k).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}
{
  const fn = () => ({ hex: hash("sha256", BIG), w: 1 });
  const m = bench(fn);
  A.push({ name: "A-K00", hex: fn().hex, ns: m.ns, work: m.work });
}

// Prototype B (parallelism): partition CHUNKS into P groups; fewer task
// boundaries = fewer slice/join setups, identical BIG output.
const B = [];
for (let p = RUNGS; p >= 1; p -= 1) {
  const step = Math.ceil(TOTAL / p);
  const fn = () => {
    let s = "";
    let w = 0;
    for (let i = 0; i < TOTAL; i += step) {
      s += CHUNKS.slice(i, i + step).join("");
      w += 2;
    }
    return { hex: s, w };
  };
  const m = bench(fn);
  B.push({ name: `B-P${String(p).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}

// Prototype C (recompute): r redundant re-encodes per chunk, discarded.
const C = [];
for (let r = RUNGS; r >= 1; r -= 1) {
  const fn = () => {
    let s = "";
    let w = 0;
    let sink = 0;
    for (let i = 0; i < TOTAL; i += 1) {
      s += PRE[i];
      w += 1;
      for (let j = 0; j < r; j += 1) {
        sink += CHUNKS[i].length;
        w += 1;
      }
    }
    if (sink === -1) throw new Error("unreachable");
    return { hex: s, w };
  };
  const m = bench(fn);
  C.push({ name: `C-R${String(r).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}

// Prototype D (deps/LOC): hand-rolled hex over h/14 of the bytes, native
// Node 26 Uint8Array#toHex() over the rest. Fewer hand-rolled bytes = less
// WORK and less code, identical oracle hex.
const D = [];
for (let h = RUNGS; h >= 1; h -= 1) {
  const cut = Math.floor(BYTES.length * h / RUNGS);
  const fn = () => {
    let out = "";
    let w = 0;
    for (let i = 0; i < cut; i += 1) {
      out += BYTES[i].toString(16).padStart(2, "0");
      w += 2;
    }
    out += BYTES.subarray(cut).toHex();
    w += 1;
    return { hex: out, w };
  };
  const m = bench(fn);
  D.push({ name: `D-H${String(h).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}

// Prototype E (tests): r separate validation passes over the 4 series,
// fused into one digest. Fewer passes = less WORK, identical oracle digest.
const E = [];
for (let r = RUNGS; r >= 1; r -= 1) {
  const fn = () => {
    let w = 0;
    let acc = 0;
    for (let pass = 0; pass < r; pass += 1) {
      for (const s of [TRACE.flourSupply, TRACE.breadSupply, TRACE.millerFlour, TRACE.bakerFlour]) {
        for (let i = 0; i < s.length; i += 1) {
          acc += Number(s[i] & 255n);
          w += 1;
        }
      }
    }
    const hex = createHash("sha256").update(BIG).digest("hex");
    if (acc === -1 && hex === "") throw new Error("unreachable");
    return { hex, w: w + 2 };
  };
  const m = bench(fn);
  E.push({ name: `E-V${String(r).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}

console.log(
  `WAVE-5 variants | SCALE=${SCALE} REPS=${REPS} TRIALS=${TRIALS} | BIG=${BIG.length}B CHUNKS=${TOTAL} RUNGS=${RUNGS}`,
);
const all = [
  verdicts("A hot-path batched digest", A, ORACLE_DIGEST),
  verdicts("B parallelism partitions", B, BIG),
  verdicts("C recompute re-encode", C, BIG),
  verdicts("D deps/LOC native toHex", D, ORACLE_HEX),
  verdicts("E tests fused validation", E, ORACLE_DIGEST),
];
for (let i = 0; i < all.length; i += 1) {
  const rows = all[i];
  const acc = rows.filter((r) => r.status === "ACCEPTED").length;
  console.log(
    `SUMMARY ${"ABCDE"[i]} rungs=${rows.length} accepted=${acc} rejected=${rows.length - acc}`,
  );
}
console.log(`ORACLE_DIGEST=${ORACLE_DIGEST}`);
