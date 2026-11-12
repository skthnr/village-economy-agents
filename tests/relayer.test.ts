import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  KeyPair,
  MultiKeySigner,
  actions as nearActions,
  buildDelegateAction,
  decodeSignedDelegate,
  encodeSignedDelegate,
  type SignedDelegate,
} from "near-api-js";

import {
  SerialQueue,
  createRelayServer,
  decodeRelayBody,
  validateDelegate,
  type RelayerConfig,
} from "../relayer/src/server.js";

const WORLD = "world.eidolon.testnet";
const ITEMS = "items.eidolon.testnet";
const COIN = "coin.eidolon.testnet";
const AGENT = "alice.world.eidolon.testnet";
const FOREIGN_AGENT = "bob.eidolon.testnet";

const KEY_PAIR = KeyPair.fromRandom("ed25519");
const SIGNER = new MultiKeySigner([KEY_PAIR]);

const CONFIG: RelayerConfig = {
  worldAccount: WORLD,
  itemsAccount: ITEMS,
  coinAccount: COIN,
  rpcUrl: "http://127.0.0.1:1",
  accountId: "relayer.eidolon.testnet",
  privateKeys: [KEY_PAIR.toString()],
};

async function makeSignedDelegate(
  senderId: string,
  receiverId: string,
  methodName: string,
): Promise<SignedDelegate> {
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId,
    actions: [
      nearActions.functionCall(methodName, {}, 30_000_000_000_000n, 0n),
    ],
    nonce: 1n,
    maxBlockHeight: 100_000_000n,
    publicKey: KEY_PAIR.getPublicKey(),
  });
  const { signedDelegate } = await SIGNER.signDelegateAction(delegateAction);
  return signedDelegate;
}

function encodeSigned(signedDelegate: SignedDelegate): string {
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
}

function functionCallAction(methodName: string): unknown {
  return { functionCall: { methodName } };
}

function delegateShape(
  receiverId: string,
  actions: unknown[],
  senderId: string = AGENT,
): unknown {
  return { delegateAction: { senderId, receiverId, actions } };
}

function assertDenied(delegate: unknown, label: string): void {
  const gate = validateDelegate(delegate, CONFIG);
  assert.equal(gate.ok, false, label);
  if (!gate.ok) {
    assert.ok(gate.reason.length > 0, label);
  }
}

test("decodeRelayBody rejects non-base64 and malformed bodies", () => {
  assert.throws(() => decodeRelayBody(null));
  assert.throws(() => decodeRelayBody([]));
  assert.throws(() => decodeRelayBody({}));
  assert.throws(() => decodeRelayBody({ signedDelegate: 42 }));
  assert.throws(() => decodeRelayBody({ signedDelegate: "" }));
  assert.throws(() => decodeRelayBody({ signedDelegate: "***not-base64***" }));
  assert.throws(() =>
    decodeRelayBody({ signedDelegate: "A".repeat(70_000) }),
  );
  assert.throws(() =>
    decodeRelayBody({
      signedDelegate: Buffer.from([1, 2, 3]).toString("base64"),
    }),
  );
});

test("decodeRelayBody round-trips a real SignedDelegate fixture", async () => {
  const signedDelegate = await makeSignedDelegate(
    AGENT,
    WORLD,
    "submit_actions",
  );
  const base64 = encodeSigned(signedDelegate);

  const body = decodeRelayBody({ signedDelegate: base64 });
  assert.equal(body.signedDelegateBase64, base64);

  const decoded = decodeSignedDelegate(
    Buffer.from(body.signedDelegateBase64, "base64"),
  );
  assert.equal(decoded.delegateAction.senderId, AGENT);
  assert.equal(decoded.delegateAction.receiverId, WORLD);
  assert.deepEqual(validateDelegate(decoded, CONFIG), {
    ok: true,
    methodNames: ["submit_actions"],
  });
});

test("validateDelegate allows the complete method matrix", () => {
  const allowed: Array<{ receiverId: string; methodName: string }> = [
    { receiverId: WORLD, methodName: "submit_actions" },
    { receiverId: WORLD, methodName: "post_order" },
    { receiverId: WORLD, methodName: "cancel_order" },
    { receiverId: ITEMS, methodName: "mt_transfer_call" },
    { receiverId: COIN, methodName: "ft_transfer_call" },
  ];

  for (const { receiverId, methodName } of allowed) {
    const gate = validateDelegate(
      delegateShape(receiverId, [functionCallAction(methodName)]),
      CONFIG,
    );
    assert.deepEqual(gate, { ok: true, methodNames: [methodName] });
  }

  const multi = validateDelegate(
    delegateShape(WORLD, [
      functionCallAction("submit_actions"),
      functionCallAction("post_order"),
    ]),
    CONFIG,
  );
  assert.deepEqual(multi, {
    ok: true,
    methodNames: ["submit_actions", "post_order"],
  });
});

test("validateDelegate denies receiver/method mismatches and non-FunctionCall actions", () => {
  const denied: Array<[string, unknown]> = [
    [
      "world receiver cannot use mt_transfer_call",
      delegateShape(WORLD, [functionCallAction("mt_transfer_call")]),
    ],
    [
      "items receiver cannot use submit_actions",
      delegateShape(ITEMS, [functionCallAction("submit_actions")]),
    ],
    [
      "coin receiver cannot use mt_transfer_call",
      delegateShape(COIN, [functionCallAction("mt_transfer_call")]),
    ],
    [
      "unknown receiver is denied",
      delegateShape("market.eidolon.testnet", [
        functionCallAction("submit_actions"),
      ]),
    ],
    [
      "world receiver cannot use an unknown method",
      delegateShape(WORLD, [functionCallAction("ft_transfer")]),
    ],
    [
      "plain Transfer action is denied",
      delegateShape(WORLD, [{ transfer: { deposit: "1" } }]),
    ],
    [
      "FunctionCall mixed with Transfer is denied",
      delegateShape(WORLD, [
        { functionCall: { methodName: "submit_actions" }, transfer: {} },
      ]),
    ],
    [
      "mismatched enum tag is denied",
      delegateShape(WORLD, [
        { functionCall: { methodName: "submit_actions" }, enum: "transfer" },
      ]),
    ],
    [
      "FunctionCall without a method name is denied",
      delegateShape(WORLD, [{ functionCall: {} }]),
    ],
    ["null action is denied", delegateShape(WORLD, [null])],
  ];

  for (const [label, delegate] of denied) {
    assertDenied(delegate, label);
  }
});

test("validateDelegate denies foreign senders and action-count violations", () => {
  const denied: Array<[string, unknown]> = [
    [
      "sender outside the world account",
      delegateShape(WORLD, [functionCallAction("submit_actions")], FOREIGN_AGENT),
    ],
    [
      "the world account itself",
      delegateShape(WORLD, [functionCallAction("submit_actions")], WORLD),
    ],
    [
      "nested sub-account",
      delegateShape(
        WORLD,
        [functionCallAction("submit_actions")],
        `alice.extra.${WORLD}`,
      ),
    ],
    [
      "uppercase sender label",
      delegateShape(
        WORLD,
        [functionCallAction("submit_actions")],
        `Alice.${WORLD}`,
      ),
    ],
    ["zero actions", delegateShape(WORLD, [])],
    [
      "nine actions",
      delegateShape(
        WORLD,
        Array.from({ length: 9 }, () => functionCallAction("submit_actions")),
      ),
    ],
    ["missing delegate action", { ok: true }],
    ["null delegate", null],
  ];

  for (const [label, delegate] of denied) {
    assertDenied(delegate, label);
  }
});

test("SerialQueue serializes per key and survives rejections", async () => {
  const queue = new SerialQueue();
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const order: string[] = [];

  const task = (key: string, label: string, ms: number): Promise<string> =>
    queue.run(key, async () => {
      const current = (active.get(key) ?? 0) + 1;
      active.set(key, current);
      peak.set(key, Math.max(peak.get(key) ?? 0, current));
      await delay(ms);
      order.push(label);
      active.set(key, (active.get(key) ?? 1) - 1);
      return label;
    });

  const results = await Promise.all([
    task("alice", "a1", 20),
    task("alice", "a2", 5),
    task("alice", "a3", 5),
    task("bob", "b1", 10),
    task("bob", "b2", 10),
  ]);

  assert.deepEqual(results, ["a1", "a2", "a3", "b1", "b2"]);
  assert.equal(peak.get("alice"), 1);
  assert.equal(peak.get("bob"), 1, "same-key tasks never overlap");
  assert.deepEqual(
    order.filter((label) => label.startsWith("a")),
    ["a1", "a2", "a3"],
  );
  assert.deepEqual(
    order.filter((label) => label.startsWith("b")),
    ["b1", "b2"],
  );

  const failing = queue.run("carol", async () => {
    await delay(5);
    throw new Error("relay failed");
  });
  const afterFailure = queue.run("carol", async () => "after");
  await assert.rejects(failing, /relay failed/);
  assert.equal(await afterFailure, "after");
});

test("createRelayServer does not listen until invoked", () => {
  const server = createRelayServer(CONFIG);
  assert.equal(server.listening, false);
});

test("relay HTTP contract: 405, 400, 413, and 403 without relaying", async (t) => {
  const server = createRelayServer(CONFIG);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP server address");
  }
  const url = `http://127.0.0.1:${address.port}/`;

  const getResponse = await fetch(url);
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");

  const malformedJson = await fetch(url, { method: "POST", body: "{" });
  assert.equal(malformedJson.status, 400);

  const notBase64 = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ signedDelegate: "***" }),
  });
  assert.equal(notBase64.status, 400);

  const invalidBorsh = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      signedDelegate: Buffer.from([1, 2, 3]).toString("base64"),
    }),
  });
  assert.equal(invalidBorsh.status, 400);

  const oversized = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ signedDelegate: "A".repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);

  const foreignSender = await makeSignedDelegate(
    FOREIGN_AGENT,
    WORLD,
    "submit_actions",
  );
  const foreignResponse = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: encodeSigned(foreignSender) }),
  });
  assert.equal(foreignResponse.status, 403);

  const wrongMethod = await makeSignedDelegate(
    AGENT,
    ITEMS,
    "submit_actions",
  );
  const wrongMethodResponse = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: encodeSigned(wrongMethod) }),
  });
  assert.equal(wrongMethodResponse.status, 403);
});
