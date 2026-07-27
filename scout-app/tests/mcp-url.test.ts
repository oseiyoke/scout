import { describe, expect, it } from "vitest";
import { isAllowedMcpUrl, isLoopbackMcpUrl } from "../src/lib/mcpUrl";

describe("MCP URL safety", () => {
  it("allows secure remote servers", () => {
    expect(isAllowedMcpUrl("https://mcp.notion.com/mcp")).toBe(true);
  });

  it("allows plain HTTP for local MCP development", () => {
    for (const url of [
      "http://localhost:4700/mcp",
      "http://127.0.0.1:4700/mcp",
      "http://[::1]:4700/mcp",
    ]) {
      expect(isLoopbackMcpUrl(url)).toBe(true);
      expect(isAllowedMcpUrl(url)).toBe(true);
    }
  });

  it("rejects insecure remote MCP URLs", () => {
    expect(isAllowedMcpUrl("http://mcp.example.com/mcp")).toBe(false);
  });
});
