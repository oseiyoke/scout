import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { McpTool } from "./types";
import { parseSseStream } from "./llm";

// Minimal MCP client for Streamable HTTP transport (modelcontextprotocol.io spec):
// POST JSON-RPC, Accept both JSON and SSE, session id header handshake.
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

export type McpTransport = (url: string, init: RequestInit) => Promise<Response>;

export class McpError extends Error {}

async function defaultTransport(url: string, init: RequestInit): Promise<Response> {
  return (await tauriFetch(url, init as never)) as unknown as Response;
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
    private transport: McpTransport = defaultTransport,
    private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    private toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS,
  ) {}

  private async request(
    init: RequestInit,
    operation: string,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new McpError(`MCP ${operation} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        this.transport(this.url, { ...init, signal: controller.signal }),
        expired,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.headers,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private captureSession(res: Response) {
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.request({
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }, method, method === "tools/call" ? this.toolCallTimeoutMs : this.requestTimeoutMs);
    this.captureSession(res);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new McpError(`MCP ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (!res.body) throw new McpError("MCP SSE response missing body");
      for await (const msg of parseSseStream(res.body)) {
        const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
        if (m.id === id) {
          if (m.error) throw new McpError(m.error.message ?? `MCP ${method} error`);
          return m.result;
        }
      }
      throw new McpError(`MCP ${method}: SSE stream ended without a response`);
    }
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new McpError(json.error.message ?? `MCP ${method} error`);
    return json.result;
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const res = await this.request({
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }, method);
    this.captureSession(res);
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new McpError(`MCP notify ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async initialize(): Promise<{ serverName: string; serverVersion: string }> {
    const result = (await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Scout", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } };
    await this.notify("notifications/initialized");
    return {
      serverName: result.serverInfo?.name ?? "unknown",
      serverVersion: result.serverInfo?.version ?? "unknown",
    };
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
      .join("\n");
    return { text, isError: result.isError === true };
  }
}
