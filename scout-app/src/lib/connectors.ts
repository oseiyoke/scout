import { McpHttpClient } from "./mcp";
import Ajv from "ajv";
import { getConnectorAuth, getConnectorHeaders, redactSecrets } from "./secrets";
import { getDb } from "./db";
import { DESTRUCTIVE_TOOL_PATTERN, READ_TOOL_PATTERN } from "./constants";
import { connectOAuthMcp, McpAuthorizationRequiredError } from "./oauth";
import { isLoopbackMcpUrl } from "./mcpUrl";
import {
  browserSweepsEnabled,
  ChromeBrowserClient,
  isBrowserReadTool,
  isBrowserTool,
  isChromeConnector,
} from "./browser";
import type { Connector, McpTool } from "./types";

export interface ConnectorClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export function isReadTool(tool: McpTool): boolean {
  if (DESTRUCTIVE_TOOL_PATTERN.test(tool.name) || tool.annotations?.destructiveHint === true) return false;
  if (tool.annotations?.readOnlyHint === true) return true;
  return isBrowserReadTool(tool.name) || READ_TOOL_PATTERN.test(tool.name);
}

const schemaValidator = new Ajv({ allErrors: true, strict: false });

function validateToolArgs(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
  const aligned = alignToolArgsToSchema(args, tool.inputSchema);
  if (!tool.inputSchema) return aligned;
  const valid = schemaValidator.validate(tool.inputSchema, aligned);
  if (!valid) {
    const detail = schemaValidator.errorsText(schemaValidator.errors, { separator: "; " });
    throw new Error(`Arguments for ${tool.name} do not match its current schema: ${detail}`);
  }
  return aligned;
}

export function isDemoConnector(connector: Pick<Connector, "url">): boolean {
  return connector.url.startsWith("demo://");
}

/**
 * LLM-authored plans sometimes mirror a snake_case tool name in its arguments,
 * even when the tool's advertised JSON schema uses camelCase. Reconcile only
 * aliases that are explicitly present in that schema; unknown arguments remain
 * untouched so the MCP server can still validate them normally.
 */
export function alignToolArgsToSchema(
  args: Record<string, unknown>,
  inputSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return args;

  const allowed = new Set(Object.keys(properties));
  const aligned = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (allowed.has(key)) continue;
    const camelCaseKey = key.replace(/_([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
    if (camelCaseKey === key || !allowed.has(camelCaseKey)) continue;
    if (!(camelCaseKey in aligned)) aligned[camelCaseKey] = value;
    delete aligned[key];
  }
  return aligned;
}

class ConnectorManager {
  private clients = new Map<string, ConnectorClient>();
  private toolCache = new Map<string, McpTool[]>();

  async connect(connector: Connector, interactive = false): Promise<McpTool[]> {
    try {
      let client: ConnectorClient;
      if (isChromeConnector(connector)) {
        client = new ChromeBrowserClient();
      } else if (isDemoConnector(connector)) {
        const { DemoConnectorClient } = await import("./demo");
        client = new DemoConnectorClient();
      } else if (connector.auth_type === "oauth" || connector.auth_type === "oauth_credentials") {
        client = await connectOAuthMcp(connector, interactive);
      } else {
        const auth = await getConnectorAuth(connector.id);
        const legacyHeaders = await getConnectorHeaders(connector.id);
        const headers = connector.auth_type === "bearer" && auth.bearerToken
          ? { Authorization: `Bearer ${auth.bearerToken}` }
          : { ...legacyHeaders, ...auth.headers };
        const http = new McpHttpClient(connector.url, headers);
        await http.initialize();
        client = http;
      }
      const tools = await client.listTools();
      this.clients.set(connector.id, client);
      this.toolCache.set(connector.id, tools);
      return tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        isLoopbackMcpUrl(connector.url)
        && /timed out|failed to fetch|error sending request|connection refused|network|tcp|dispatch failure/i.test(message)
      ) {
        throw new Error(`Could not reach ${connector.name} at ${connector.url}. Start the local server, then try again.`);
      }
      throw error;
    }
  }

  async disconnect(connectorId: string): Promise<void> {
    const client = this.clients.get(connectorId) as ConnectorClient & { close?: () => Promise<void> };
    const closing = client?.close?.();
    if (closing) await closing;
    this.clients.delete(connectorId);
    this.toolCache.delete(connectorId);
  }

  /** Test hook: register a fake client without a network handshake. */
  __register(connectorId: string, client: ConnectorClient, tools: McpTool[]) {
    this.clients.set(connectorId, client);
    this.toolCache.set(connectorId, tools);
  }

  isConnected(connectorId: string): boolean {
    return this.clients.has(connectorId);
  }

  tools(connectorId: string): McpTool[] {
    return this.toolCache.get(connectorId) ?? [];
  }

  async refreshTools(connectorId: string): Promise<McpTool[]> {
    const client = this.clients.get(connectorId);
    if (!client) return [];
    const tools = await client.listTools();
    this.toolCache.set(connectorId, tools);
    return tools;
  }

  readTools(connectorId: string): McpTool[] {
    return this.tools(connectorId).filter(isReadTool);
  }

  writeTools(connectorId: string): McpTool[] {
    return this.tools(connectorId).filter((t) => !isReadTool(t));
  }

  /** GUARDRAIL: sweeps may only ever call read tools. Enforced here, not just in the prompt. */
  async callReadTool(
    connectorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const tools = this.tools(connectorId);
    const t = tools.find((x) => x.name === tool);
    if (!t) throw new Error(`Tool ${tool} not found on connector ${connectorId}`);
    if (!isReadTool(t)) throw new Error(`Refused: ${tool} is a write tool; sweeps are read-only`);
    if (isBrowserTool(tool) && !(await browserSweepsEnabled())) {
      throw new Error("Browser reading is disabled for scheduled sweeps");
    }
    return this.call(connectorId, tool, args);
  }

  /** Interactive task chat may inspect any connected read-only source, including Chrome. */
  async callInteractiveReadTool(
    connectorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const candidate = this.tools(connectorId).find((item) => item.name === tool);
    if (!candidate) throw new Error(`Tool ${tool} not found on connector ${connectorId}`);
    if (!isReadTool(candidate)) throw new Error(`Refused: ${tool} can change external data`);
    return this.call(connectorId, tool, args);
  }

  /** Executor path — only invoked after explicit user approval. */
  async callWriteTool(
    connectorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const candidate = this.tools(connectorId).find((item) => item.name === tool);
    if (!candidate) throw new Error(`Tool ${tool} not found on connector ${connectorId}`);
    if (isReadTool(candidate)) throw new Error(`Refused: ${tool} is read-only and is not an executable action`);
    return this.call(connectorId, tool, args);
  }

  private async call(
    connectorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const client = this.clients.get(connectorId);
    if (!client) throw new Error(`Connector ${connectorId} is not connected`);
    const candidate = this.tools(connectorId).find((item) => item.name === tool);
    if (!candidate) throw new Error(`Tool ${tool} not found on connector ${connectorId}`);
    return client.callTool(tool, validateToolArgs(candidate, args));
  }
}

export const connectorManager = new ConnectorManager();

/** Connect all enabled connectors; update DB status per connector. */
export async function connectEnabled(): Promise<Connector[]> {
  const db = await getDb();
  const connectors = await db.select<Connector[]>("SELECT * FROM connectors WHERE enabled=1;");
  for (const c of connectors) {
    if (connectorManager.isConnected(c.id)) continue;
    try {
      const tools = await connectorManager.connect(c, false);
      const connectedAt = new Date().toISOString();
      await db.execute(
        "UPDATE connectors SET status='connected', last_error=NULL, tool_count=$1, last_connected_at=$2 WHERE id=$3;",
        [tools.length, connectedAt, c.id],
      );
      c.status = "connected";
      c.tool_count = tools.length;
      c.last_connected_at = connectedAt;
    } catch (e) {
      const needsAuth = e instanceof McpAuthorizationRequiredError;
      await db.execute("UPDATE connectors SET status=$1, last_error=$2 WHERE id=$3;", [
        needsAuth ? "disconnected" : "error",
        needsAuth ? null : redactSecrets(e instanceof Error ? e.message : String(e)),
        c.id,
      ]);
      c.status = needsAuth ? "disconnected" : "error";
      c.last_error = needsAuth ? null : redactSecrets(e instanceof Error ? e.message : String(e));
    }
  }
  return connectors;
}
