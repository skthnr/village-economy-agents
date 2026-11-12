import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

import {
  Account,
  JsonRpcProvider,
  MultiKeySigner,
  decodeSignedDelegate,
  type KeyPairString,
  type SignedDelegate,
} from "near-api-js";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RPC_URL = "https://rpc.testnet.fastnear.com";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

const WORLD_METHODS = ["submit_actions", "post_order", "cancel_order"] as const;
const ITEMS_METHODS = ["mt_transfer_call"] as const;
const COIN_METHODS = ["ft_transfer_call"] as const;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Runtime configuration for the gasless NEP-366 relayer. */
export interface RelayerConfig {
  /** World contract that receives `submit_actions` / `post_order` / `cancel_order`. */
  worldAccount: string;
  /** Items contract that receives `mt_transfer_call`. */
  itemsAccount: string;
  /** Coin contract that receives `ft_transfer_call`. */
  coinAccount: string;
  /** NEAR RPC endpoint used by the relayer account. */
  rpcUrl: string;
  /** Account that pays gas for the outer meta transaction. */
  accountId: string;
  /** Comma-free list of curve-prefixed secret keys (`ed25519:...`) for key rotation. */
  signerKeys: string[];
}

interface RelayContext {
  readonly config: RelayerConfig;
  readonly account: Account;
  readonly queue: SerialQueue;
}

class BodyTooLargeError extends Error {}

/**
 * In-memory promise queue that serializes tasks per key.
 *
 * The relayer uses the delegate sender account as the key: two delegates from
 * the same access key must never be submitted concurrently, otherwise their
 * nonces can race. A rejected task never poisons the queue for later tasks.
 */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }
}

/**
 * Parses the HTTP payload and proves it contains one canonical Borsh
 * `SignedDelegate`. Base64 is checked strictly; the delegate is decoded here so
 * malformed bytes are rejected before the gate runs.
 */
function parseRelayBody(body: unknown): {
  signedDelegateBase64: string;
  signedDelegate: SignedDelegate;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("relay body must be a JSON object");
  }
  if (!("signedDelegate" in body)) {
    throw new Error("signedDelegate must be a non-empty base64 string");
  }
  const encoded = body.signedDelegate;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("signedDelegate must be a non-empty base64 string");
  }
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error("signedDelegate must be base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_BODY_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    throw new Error("signedDelegate must be canonical base64");
  }
  return {
    signedDelegateBase64: encoded,
    signedDelegate: decodeSignedDelegate(bytes),
  };
}

/**
 * Validates the HTTP request shape and returns the canonical base64 delegate.
 * Throws on non-object bodies, non-base64 strings, and non-canonical Borsh.
 */
export function decodeRelayBody(body: unknown): { signedDelegateBase64: string } {
  const { signedDelegateBase64 } = parseRelayBody(body);
  return { signedDelegateBase64 };
}

/**
 * Policy gate for relayed delegate actions. This is the security boundary:
 * the decoder restores signatures but does not verify them, and a meta
 * transaction bypasses the sender's function-call access-key allowance.
 */
export function validateDelegate(
  delegate: unknown,
  config: RelayerConfig,
): { ok: true; methodNames: string[] } | { ok: false; reason: string } {
  if (
    typeof delegate !== "object" ||
    delegate === null ||
    Array.isArray(delegate)
  ) {
    return deny("delegate is not an object");
  }
  if (!("delegateAction" in delegate)) {
    return deny("delegateAction is missing");
  }
  const delegateAction = delegate.delegateAction;
  if (
    typeof delegateAction !== "object" ||
    delegateAction === null ||
    Array.isArray(delegateAction)
  ) {
    return deny("delegateAction is missing");
  }

  const senderId =
    "senderId" in delegateAction ? delegateAction.senderId : undefined;
  if (
    typeof senderId !== "string" ||
    !isSubAccountOfWorld(senderId, config.worldAccount)
  ) {
    return deny("senderId must be a sub-account of the world account");
  }

  const receiverId =
    "receiverId" in delegateAction ? delegateAction.receiverId : undefined;
  if (typeof receiverId !== "string") {
    return deny("receiverId is missing");
  }
  const allowedMethods = methodsForReceiver(receiverId, config);
  if (allowedMethods === undefined) {
    return deny("receiverId is not a relayer target");
  }

  const actions = "actions" in delegateAction ? delegateAction.actions : undefined;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 8) {
    return deny("delegate must contain 1 to 8 actions");
  }

  const methodNames: string[] = [];
  for (const action of actions) {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      return deny("action is not an object");
    }
    if (
      "enum" in action &&
      typeof action.enum === "string" &&
      action.enum !== "functionCall"
    ) {
      return deny("only FunctionCall actions are allowed");
    }
    for (const key of Object.keys(action)) {
      if (key !== "functionCall" && key !== "enum") {
        return deny("only FunctionCall actions are allowed");
      }
    }
    const call = "functionCall" in action ? action.functionCall : undefined;
    if (
      typeof call !== "object" ||
      call === null ||
      Array.isArray(call) ||
      !("methodName" in call) ||
      typeof call.methodName !== "string"
    ) {
      return deny("only FunctionCall actions are allowed");
    }
    const methodName = call.methodName;
    if (!allowedMethods.includes(methodName)) {
      return deny(`method ${methodName} is not allowed for ${receiverId}`);
    }
    methodNames.push(methodName);
  }

  return { ok: true, methodNames };
}

/**
 * Creates the relayer HTTP server without listening.
 *
 * The caller must invoke `listen` explicitly (or use `startRelayer`). No NEAR
 * RPC call happens during construction.
 */
export function createRelayServer(config: RelayerConfig): Server {
  assertConfig(config);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = MultiKeySigner.fromSecretKeys(
    config.signerKeys as KeyPairString[],
  );
  const account = new Account(config.accountId, provider, signer);
  const context: RelayContext = { config, account, queue: new SerialQueue() };

  return createServer((request, response) => {
    void handleRequest(request, response, context).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal relayer error" });
      } else {
        response.end();
      }
    });
  });
}

/**
 * Starts the relayer on `RELAYER_HOST:RELAYER_PORT` (default
 * `127.0.0.1:8787`). When `config` is omitted it is read from the environment:
 * `WORLD_ACCOUNT`, `ITEMS_ACCOUNT`, `COIN_ACCOUNT`, `NEAR_RPC_URL`,
 * `RELAYER_ACCOUNT`, and `RELAYER_PRIVATE_KEYS`.
 */
export function startRelayer(config: RelayerConfig = configFromEnv()): Server {
  const server = createRelayServer(config);
  const port = Number.parseInt(process.env.RELAYER_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.RELAYER_HOST?.trim() || DEFAULT_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("RELAYER_PORT must be an integer between 0 and 65535");
  }
  server.listen(port, host, () => {
    console.log(`eidolon relayer listening on http://${host}:${port}`);
  });
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RelayContext,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRequestBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(response, 413, { error: "request body exceeds 64 KiB" });
    } else {
      sendJson(response, 400, { error: "unreadable request body" });
    }
    return;
  }

  let signedDelegate: SignedDelegate;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    signedDelegate = parseRelayBody(parsed).signedDelegate;
  } catch {
    sendJson(response, 400, { error: "malformed relay request" });
    return;
  }

  const gate = validateDelegate(signedDelegate, context.config);
  if (!gate.ok) {
    sendJson(response, 403, { error: gate.reason });
    return;
  }

  try {
    const result = await context.queue.run(
      signedDelegate.delegateAction.senderId,
      () => context.account.relayMetaTransaction(signedDelegate),
    );
    sendJson(response, 200, {
      transactionHash: result.transaction_outcome.id,
      status: statusLabel(result.status),
    });
  } catch {
    sendJson(response, 502, { error: "relay submission failed" });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new BodyTooLargeError();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function statusLabel(status: unknown): string {
  if (typeof status === "string") {
    return status;
  }
  if (typeof status === "object" && status !== null && !Array.isArray(status)) {
    if ("SuccessValue" in status) {
      return "SuccessValue";
    }
    if ("Failure" in status) {
      return "Failure";
    }
  }
  return "Unknown";
}

function methodsForReceiver(
  receiverId: string,
  config: RelayerConfig,
): readonly string[] | undefined {
  if (receiverId === config.worldAccount) {
    return WORLD_METHODS;
  }
  if (receiverId === config.itemsAccount) {
    return ITEMS_METHODS;
  }
  if (receiverId === config.coinAccount) {
    return COIN_METHODS;
  }
  return undefined;
}

/**
 * Requires exactly `<name>.<worldAccount>`: one immediate sub-account label.
 * This matches the accounts created by the world's `create_agent`.
 */
function isSubAccountOfWorld(senderId: string, worldAccount: string): boolean {
  if (worldAccount.length === 0 || senderId.length > 64) {
    return false;
  }
  const suffix = `.${worldAccount}`;
  if (!senderId.endsWith(suffix)) {
    return false;
  }
  const name = senderId.slice(0, senderId.length - suffix.length);
  return name.length > 0 && /^[a-z0-9_-]+$/.test(name);
}

function assertConfig(config: RelayerConfig): void {
  for (const field of [
    "worldAccount",
    "itemsAccount",
    "coinAccount",
    "rpcUrl",
    "accountId",
  ] as const) {
    const value = config[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`relayer config: ${field} is required`);
    }
  }
  if (!Array.isArray(config.signerKeys) || config.signerKeys.length === 0) {
    throw new Error("relayer config: signerKeys must contain at least one key");
  }
}

function configFromEnv(): RelayerConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is not set`);
    }
    return value;
  };
  const signerKeys = required("RELAYER_PRIVATE_KEYS")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (signerKeys.length === 0) {
    throw new Error("RELAYER_PRIVATE_KEYS is empty");
  }
  return {
    worldAccount: required("WORLD_ACCOUNT"),
    itemsAccount: required("ITEMS_ACCOUNT"),
    coinAccount: required("COIN_ACCOUNT"),
    rpcUrl: process.env.NEAR_RPC_URL?.trim() || DEFAULT_RPC_URL,
    accountId: required("RELAYER_ACCOUNT"),
    signerKeys,
  };
}

function deny(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}



const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  startRelayer();
}
