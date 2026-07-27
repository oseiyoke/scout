import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// Legacy file store is read only for one-time migration into the OS credential vault.
const legacyStore = new LazyStore("secrets.json");

const API_KEY = "api_key";
const connectorHeadersKey = (connectorId: string) => `connector:${connectorId}:headers`;
const connectorAuthKey = (connectorId: string) => `connector:${connectorId}:auth`;

function hasNativeSecretStore(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function readSecret<T>(key: string): Promise<T | undefined> {
  if (!hasNativeSecretStore()) return legacyStore.get<T>(key);

  const encoded = await invoke<string | null>("get_secret", { key });
  if (encoded) return JSON.parse(encoded) as T;

  const legacy = await legacyStore.get<T>(key);
  if (legacy !== undefined) {
    await invoke("set_secret", { key, value: JSON.stringify(legacy) });
    await legacyStore.delete(key);
    await legacyStore.save();
  }
  return legacy;
}

async function writeSecret(key: string, value: unknown): Promise<void> {
  if (!hasNativeSecretStore()) {
    await legacyStore.set(key, value);
    await legacyStore.save();
    return;
  }
  await invoke("set_secret", { key, value: JSON.stringify(value) });
}

async function removeSecret(key: string): Promise<void> {
  if (hasNativeSecretStore()) await invoke("delete_secret", { key });
  await legacyStore.delete(key);
  await legacyStore.save();
}

export interface ConnectorAuthSecret {
  clientId?: string;
  clientSecret?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
}

export async function getApiKey(): Promise<string> {
  return (await getApiKeyInfo()).key;
}

export interface ApiKeyInfo {
  key: string;
  provider?: "moonshot" | "openrouter";
}

export async function getApiKeyInfo(): Promise<ApiKeyInfo> {
  const v = await readSecret<string>(API_KEY);
  if (v) return { key: v };
  return { key: "" };
}

export async function setApiKey(key: string): Promise<void> {
  await writeSecret(API_KEY, key);
}

export async function deleteApiKey(): Promise<void> {
  await removeSecret(API_KEY);
}

export async function getConnectorHeaders(connectorId: string): Promise<Record<string, string>> {
  const v = await readSecret<Record<string, string>>(connectorHeadersKey(connectorId));
  return v ?? {};
}

export async function setConnectorHeaders(
  connectorId: string,
  headers: Record<string, string>,
): Promise<void> {
  await writeSecret(connectorHeadersKey(connectorId), headers);
}

export async function deleteConnectorHeaders(connectorId: string): Promise<void> {
  await removeSecret(connectorHeadersKey(connectorId));
}

export async function getConnectorAuth(connectorId: string): Promise<ConnectorAuthSecret> {
  return (await readSecret<ConnectorAuthSecret>(connectorAuthKey(connectorId))) ?? {};
}

export async function updateConnectorAuth(
  connectorId: string,
  update: Partial<ConnectorAuthSecret>,
): Promise<void> {
  const current = await getConnectorAuth(connectorId);
  await writeSecret(connectorAuthKey(connectorId), { ...current, ...update });
}

export async function setConnectorAuth(
  connectorId: string,
  auth: ConnectorAuthSecret,
): Promise<void> {
  await writeSecret(connectorAuthKey(connectorId), auth);
}

export async function deleteConnectorAuth(connectorId: string): Promise<void> {
  await removeSecret(connectorAuthKey(connectorId));
}

/** Strip anything that looks like a credential from text before logging/persisting. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, "$1[REDACTED]")
    .replace(
      /("?(?:authorization|x-api-key|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|bearer[-_]?token)"?\s*[:=]\s*"?)[^",&\s}]+/gi,
      "$1[REDACTED]",
    );
}
