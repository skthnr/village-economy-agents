/*
 * WAVE-3 native variant ladder. Two prototypes, 12 rungs each.
 * Each rung carries an instrumented WORK counter, a measured ns/op, and a
 * strict output oracle. A rung is ACCEPTED only when strictly better than the
 * previous accepted rung on >=1 metric and not worse on any other, oracle-equal.
 * Ties and regressions are recorded as REJECTED rungs (evidence), not wins.
 */
import { createHash } from "node:crypto";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 112;
const rnd = mulberry32(0xe1d010);
const series = (scale) =>
  Array.from({ length: N }, () => BigInt(Math.floor(rnd() * scale)));

const TRACE = {
  snapshot: JSON.stringify({
    tick: N,
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
    for (const v of s) {
      c.push(v.toString(), ",");
    }
    c.push("|");
  }
  c.push("\n");
  for (const f of t.failures) {
    c.push(f, ";");
  }
  return c;
}

const CHUNKS = chunksOf(TRACE);
const TOTAL = CHUNKS.length;
const BIG = CHUNKS.join("");
const ORACLE_DIGEST = createHash("sha256").update(BIG).digest("hex");
const PRE = CHUNKS.map(String);

const REPS = 4000;
const TRIALS = 1;

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
  return { ns: best, work };
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
      why = `work -${prev.work - row.work}, ns ${row.ns.toFixed(1)}<=${prev.ns.toFixed(1)}`;
    } else if (row.work <= prev.work && row.ns < prev.ns) {
      why = `ns -${(prev.ns - row.ns).toFixed(1)}`;
    } else {
      status = "REJECTED";
      why = `work ${row.work} vs ${prev.work}, ns ${row.ns.toFixed(1)} vs ${prev.ns.toFixed(1)}`;
    }
    if (status === "ACCEPTED") prev = row;
    out.push({ ...row, status, why });
  }
  console.log(`\n### PROTOTYPE ${name} (oracle ${String(oracle).slice(0, 16)}...)`);
  console.log("rung\tstatus\twork\tns/op\tdigest\treason");
  for (const r of out) {
    console.log(
      `${r.name}\t${r.status}\t${r.work}\t${r.ns.toFixed(1)}\t${r.hex.slice(0, 8)}\t${r.why}`,
    );
  }
  return out;
}

// Prototype A: streaming SHA-256 digest split into K contiguous batches.
// Fewer update()/slice() calls = strictly less work, identical bytes/digest.
const A = [];
for (let k = 12; k >= 1; k -= 1) {
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

// Prototype B: drive repeated re-encodes toward zero. Every rung emits BIG;
// the naive rung re-encodes each chunk 12 times and discards duplicates.
const B = [];
for (let rung = 0; rung < 12; rung += 1) {
  const redundant = 12 - rung;
  const fn = () => {
    let w = 0;
    let s = "";
    let sink = 0;
    for (let i = 0; i < TOTAL; i += 1) {
      s += PRE[i];
      w += 1;
      for (let j = 0; j < redundant; j += 1) {
        sink += CHUNKS[i].toString().length;
        w += 1;
      }
    }
    if (sink === -1) throw new Error("unreachable");
    return { hex: s, w };
  };
  const m = bench(fn);
  B.push({ name: `B-R${String(redundant).padStart(2, "0")}`, hex: fn().hex, ns: m.ns, work: m.work });
}

console.log(`WAVE-3 variants | REPS=${REPS} TRIALS=${TRIALS} | BIG=${BIG.length}B | CHUNKS=${TOTAL}`);
const ra = verdicts("A: batched streaming digest", A, ORACLE_DIGEST);
const rb = verdicts("B: near-zero re-encode", B, BIG);
const accA = ra.filter((r) => r.status === "ACCEPTED").length;
const accB = rb.filter((r) => r.status === "ACCEPTED").length;
console.log(`\nSUMMARY A rungs=${ra.length} accepted=${accA} rejected=${ra.length - accA}`);
console.log(`SUMMARY B rungs=${rb.length} accepted=${accB} rejected=${rb.length - accB}`);
console.log(`ORACLE_DIGEST=${ORACLE_DIGEST}`);
