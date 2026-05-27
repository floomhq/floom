import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoredCredentials = {
  api_base: string;
  api_secret: string;
  authed_at: string;
};

const DEFAULT_API_BASE = "https://workers-api.floom.dev";

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function credentialsPath(): string {
  const home = resolveHomeDir();
  if (!home) {
    throw new Error("HOME is required to read CLI credentials");
  }
  return join(home, ".config", "workeros", "credentials.json");
}

export async function readCredentials(): Promise<StoredCredentials | null> {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return null;
  }
  const raw = (await readFile(path, "utf8")).trim();
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
  if (!parsed.api_secret) {
    return null;
  }
  return {
    api_base: (parsed.api_base || DEFAULT_API_BASE).replace(/\/+$/, ""),
    api_secret: parsed.api_secret,
    authed_at: parsed.authed_at || new Date().toISOString(),
  };
}

export async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(credentials, null, 2);
  await writeFile(path, `${payload}\n`, "utf8");
  chmodSync(path, 0o600);
}

export async function clearCredentials(): Promise<boolean> {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "*".repeat(secret.length);
  return `${"*".repeat(secret.length - 4)}${secret.slice(-4)}`;
}
