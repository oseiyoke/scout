import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  getConnectorAuth,
  updateConnectorAuth,
  type ConnectorAuthSecret,
} from "./secrets";
import type { Connector, McpTool } from "./types";

export const OAUTH_CALLBACK_URL = "http://127.0.0.1:3119/oauth/callback";
const CONNECTION_TIMEOUT_MS = 20_000;

export class McpAuthorizationRequiredError extends Error {
  constructor() {
    super("Sign in is required to connect this MCP server");
  }
}

interface OAuthCallbackPayload {
  connectorId: string;
  url?: string;
  error?: string;
}

export interface OAuthCallbackWaiter {
  result: Promise<string>;
  dispose: () => void;
}

type OAuthCallbackSubscribe = (
  handler: (payload: OAuthCallbackPayload) => void,
) => Promise<() => void>;

class StoredOAuthProvider implements OAuthClientProvider {
  private auth: ConnectorAuthSecret;
  private readonly pendingState: string;

  constructor(
    private readonly connectorId: string,
    private readonly _redirectUrl: string,
    auth: ConnectorAuthSecret,
    private readonly interactive: boolean,
  ) {
    this.auth = auth;
    this.pendingState = crypto.randomUUID();
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Scout",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.auth.clientSecret ? "client_secret_post" : "none",
    };
  }

  async state(): Promise<string> {
    await this.persist({ state: this.pendingState });
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.auth.clientId) {
      return {
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret || undefined,
      };
    }
    return this.auth.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.persist({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.auth.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.persist({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.interactive) await openUrl(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.persist({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.auth.codeVerifier) throw new Error("OAuth code verifier is missing; start sign-in again");
    return this.auth.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.persist({ discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.auth.discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const update: Partial<ConnectorAuthSecret> = {};
    if (scope === "all" || scope === "tokens") update.tokens = undefined;
    if (scope === "all" || scope === "verifier") update.codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") update.discoveryState = undefined;
    if ((scope === "all" || scope === "client") && !this.auth.clientId) {
      update.clientInformation = undefined;
    }
    await this.persist(update);
  }

  private async persist(update: Partial<ConnectorAuthSecret>): Promise<void> {
    this.auth = { ...this.auth, ...update };
    await updateConnectorAuth(this.connectorId, update);
  }
}

export class OAuthMcpClient {
  constructor(private readonly client: Client) {}

  async listTools(): Promise<McpTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (Array.isArray(result.content) ? result.content : []) as Array<{
      type?: string;
      text?: string;
      [key: string]: unknown;
    }>;
    const text = content
      .map((item) => (item.type === "text" ? (item.text ?? "") : JSON.stringify(item)))
      .join("\n");
    return { text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Register the frontend event listener without awaiting the callback itself.
 * Returning the result Promise inside an object is intentional: async functions
 * flatten a directly returned Promise, which would deadlock before OAuth opens.
 */
export async function createOAuthCallbackWaiter(
  connectorId: string,
  subscribe: OAuthCallbackSubscribe = async (handler) =>
    listen<OAuthCallbackPayload>("scout:oauth-callback", (event) => handler(event.payload)),
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackWaiter> {
  let unlisten: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const dispose = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    unlisten?.();
    unlisten = undefined;
  };
  const result = new Promise<string>((resolve, reject) => {
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      dispose();
      action();
    };
    timeout = setTimeout(() => {
      settle(() => reject(new Error("Sign-in timed out. Try connecting again.")));
    }, timeoutMs);

    void subscribe((payload) => {
      if (payload.connectorId !== connectorId) return;
      if (payload.error || !payload.url) {
        settle(() => reject(new Error(payload.error || "The OAuth callback did not include a URL")));
      } else {
        settle(() => resolve(payload.url!));
      }
    }).then((disposeListener) => {
      if (settled) {
        disposeListener();
        return;
      }
      unlisten = disposeListener;
    }).catch((error) => {
      settle(() => reject(error));
    });
  });

  // Wait only for event subscription, never for the OAuth redirect itself.
  while (!unlisten && !settled) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  void result.catch(() => {});
  return { result, dispose };
}

async function makeConnection(connector: Connector, provider: StoredOAuthProvider) {
  const client = new Client({ name: "Scout", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(connector.url), {
    authProvider: provider,
    fetch: tauriFetch as unknown as typeof fetch,
  });
  await connectWithinTimeout(client, transport, connector.name);
  return { client, transport };
}

async function connectWithinTimeout(
  client: Client,
  transport: StreamableHTTPClientTransport,
  connectorName: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${connectorName} did not respond within 20 seconds. Check the server URL and try again.`)),
      CONNECTION_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([client.connect(transport), expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function tryStoredConnection(connector: Connector): Promise<OAuthMcpClient> {
  const auth = await getConnectorAuth(connector.id);
  const provider = new StoredOAuthProvider(connector.id, OAUTH_CALLBACK_URL, auth, false);
  try {
    const { client } = await makeConnection(connector, provider);
    return new OAuthMcpClient(client);
  } catch (error) {
    if (error instanceof UnauthorizedError) throw new McpAuthorizationRequiredError();
    throw error;
  }
}

export async function connectOAuthMcp(connector: Connector, interactive: boolean): Promise<OAuthMcpClient> {
  try {
    return await tryStoredConnection(connector);
  } catch (error) {
    if (!(error instanceof McpAuthorizationRequiredError) || !interactive) throw error;
  }

  const callbackWaiter = await createOAuthCallbackWaiter(connector.id);
  let callbackStarted = false;
  try {
    const callbackUrl = await invoke<string>("start_oauth_callback", { connectorId: connector.id });
    callbackStarted = true;
    const auth = await getConnectorAuth(connector.id);
    const provider = new StoredOAuthProvider(connector.id, callbackUrl, auth, true);
    const client = new Client({ name: "Scout", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(connector.url), {
      authProvider: provider,
      fetch: tauriFetch as unknown as typeof fetch,
    });

    try {
      // This triggers discovery and redirectToAuthorization, which opens the browser.
      await connectWithinTimeout(client, transport, connector.name);
      return new OAuthMcpClient(client);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }

    const returnedUrl = new URL(await callbackWaiter.result);
    const oauthError = returnedUrl.searchParams.get("error");
    if (oauthError) {
      throw new Error(returnedUrl.searchParams.get("error_description") || oauthError);
    }
    const returnedState = returnedUrl.searchParams.get("state");
    const expectedState = (await getConnectorAuth(connector.id)).state;
    if (!returnedState || returnedState !== expectedState) {
      throw new Error("OAuth state did not match. Sign-in was stopped to protect this connection.");
    }
    const code = returnedUrl.searchParams.get("code");
    if (!code) throw new Error("The authorization server did not return an OAuth code");

    await transport.finishAuth(code);
    return tryStoredConnection(connector);
  } finally {
    callbackWaiter.dispose();
    if (callbackStarted) {
      await invoke("cancel_oauth_callback", { connectorId: connector.id }).catch(() => {});
    }
  }
}

export async function clearOAuthSession(connectorId: string): Promise<void> {
  await updateConnectorAuth(connectorId, {
    tokens: undefined,
    codeVerifier: undefined,
    state: undefined,
    discoveryState: undefined,
  });
}
