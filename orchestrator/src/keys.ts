import { KeyPair, type KeyPairString } from "near-api-js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface AgentKeys {
  name: string;
  fck: KeyPair;
  market: KeyPair;
  publicKeys: {
    fck: string;
    market: string;
  };
}

interface StoredAgentKeys {
  name: string;
  fck_secret_key: string;
  market_secret_key: string;
}

function keystoreDirectory(): string {
  return resolve(process.env.AGENT_KEYSTORE_DIR ?? ".keys");
}

function keyFile(name: string): string {
  return join(keystoreDirectory(), `${name}.json`);
}

export async function ensureAgentKeys(names: readonly string[]): Promise<Map<string, AgentKeys>> {
  await mkdir(keystoreDirectory(), { recursive: true, mode: 0o700 });
  const keys = new Map<string, AgentKeys>();
  for (const name of names) {
    keys.set(name, await loadOrCreate(name));
  }
  return keys;
}

export async function loadAgentKeys(name: string): Promise<AgentKeys> {
  const stored = await readStoredKeys(name);
  if (stored === undefined) {
    throw new Error(`no keystore entry for ${name}; call ensureAgentKeys first`);
  }
  return parseStoredKeys(stored, name);
}

async function loadOrCreate(name: string): Promise<AgentKeys> {
  const existing = await readStoredKeys(name);
  if (existing !== undefined) {
    return parseStoredKeys(existing, name);
  }

  const stored: StoredAgentKeys = {
    name,
    fck_secret_key: KeyPair.fromRandom("ed25519").toString(),
    market_secret_key: KeyPair.fromRandom("ed25519").toString(),
  };
  const target = keyFile(name);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return parseStoredKeys(stored, name);
}

async function readStoredKeys(name: string): Promise<StoredAgentKeys | undefined> {
  let content: string;
  try {
    content = await readFile(keyFile(name), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`keystore entry for ${name} must be an object`);
  }
  if (!("name" in parsed) || parsed.name !== name) {
    throw new TypeError(`keystore entry does not belong to ${name}`);
  }
  if (!("fck_secret_key" in parsed) || typeof parsed.fck_secret_key !== "string") {
    throw new TypeError(`keystore entry for ${name} has no fck_secret_key`);
  }
  if (!("market_secret_key" in parsed) || typeof parsed.market_secret_key !== "string") {
    throw new TypeError(`keystore entry for ${name} has no market_secret_key`);
  }

  return {
    name,
    fck_secret_key: parsed.fck_secret_key,
    market_secret_key: parsed.market_secret_key,
  };
}

function parseStoredKeys(stored: StoredAgentKeys, expectedName: string): AgentKeys {
  const fck = parseSecretKey(stored.fck_secret_key, expectedName, "fck");
  const market = parseSecretKey(stored.market_secret_key, expectedName, "market");
  const publicKeys = {
    fck: fck.getPublicKey().toString(),
    market: market.getPublicKey().toString(),
  };
  if (publicKeys.fck === publicKeys.market) {
    throw new TypeError(`keystore entry for ${expectedName} uses the same ed25519 key for both roles`);
  }
  return {
    name: expectedName,
    fck,
    market,
    publicKeys,
  };
}

function parseSecretKey(secret: string, agent: string, role: "fck" | "market"): KeyPair {
  try {
    return KeyPair.fromString(secret as KeyPairString);
  } catch {
    throw new TypeError(`keystore entry for ${agent} has an invalid ${role}_secret_key`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
