import { describe, it, expect } from "vitest";
import { McpHttpClient } from "../src/lib/mcp";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponseFor(id: number, result: unknown): Response {
  const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("MCP Streamable HTTP client", () => {
  it("handshakes: initialize, captures session id, sends it afterwards", async () => {
    const seen: { headers: Headers; body: string }[] = [];
    const transport = async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body) });
      const req = JSON.parse(String(init.body));
      if (req.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: req.id, result: { serverInfo: { name: "fake", version: "1" } } },
          { "mcp-session-id": "sess-123" },
        );
      }
      return new Response(null, { status: 202 });
    };
    const client = new McpHttpClient("http://x/mcp", { Authorization: "Bearer t" }, transport);
    const info = await client.initialize();
    expect(info.serverName).toBe("fake");
    expect(seen).toHaveLength(2); // initialize + notifications/initialized
    expect(seen[1].body).toContain("notifications/initialized");
    expect(seen[1].headers.get("mcp-session-id")).toBe("sess-123");
    expect(seen[0].headers.get("authorization")).toBe("Bearer t");
    expect(seen[0].headers.get("accept")).toContain("text/event-stream");
  });

  it("lists tools from a JSON response", async () => {
    const transport = async (_u: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "read_x" }] } });
    };
    const tools = await new McpHttpClient("http://x/mcp", {}, transport).listTools();
    expect(tools[0].name).toBe("read_x");
  });

  it("calls tools and unwraps text content", async () => {
    const transport = async (_u: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      expect(req.method).toBe("tools/call");
      expect(req.params.name).toBe("search_gmail");
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: "3 emails" }] },
      });
    };
    const r = await new McpHttpClient("http://x/mcp", {}, transport).callTool("search_gmail", { q: "unread" });
    expect(r.text).toBe("3 emails");
    expect(r.isError).toBe(false);
  });

  it("resolves responses delivered over an SSE stream", async () => {
    const transport = async (_u: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      return sseResponseFor(req.id, { tools: [{ name: "streamed_tool" }] });
    };
    const tools = await new McpHttpClient("http://x/mcp", {}, transport).listTools();
    expect(tools[0].name).toBe("streamed_tool");
  });

  it("surfaces JSON-RPC errors", async () => {
    const transport = async (_u: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      return jsonResponse({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
    };
    await expect(new McpHttpClient("http://x/mcp", {}, transport).listTools()).rejects.toThrow("method not found");
  });

  it("surfaces HTTP errors", async () => {
    const transport = async () => new Response("boom", { status: 500 });
    await expect(new McpHttpClient("http://x/mcp", {}, transport).listTools()).rejects.toThrow("500");
  });

  it("stops waiting when a local MCP server never responds", async () => {
    let signal: AbortSignal | null | undefined;
    const transport = (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    };
    const client = new McpHttpClient("http://localhost:4700/mcp", {}, transport, 5);

    await expect(client.initialize()).rejects.toThrow("MCP initialize timed out after 1 seconds");
    expect(signal?.aborted).toBe(true);
  });

  it("allows longer tool execution without weakening connection timeouts", async () => {
    const transport = () => new Promise<Response>(() => {});
    const client = new McpHttpClient("http://x/mcp", {}, transport, 5, 25);

    await expect(client.callTool("generate_design", {})).rejects.toThrow(
      "MCP tools/call timed out after 1 seconds",
    );
  });
});
