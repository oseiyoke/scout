import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type HttpPermission = {
  identifier: string;
  allow?: Array<{ url: string }>;
};

const capabilityPath = fileURLToPath(
  new URL("../src-tauri/capabilities/default.json", import.meta.url),
);

function configuredHttpPatterns(): string[] {
  const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
    permissions: Array<string | HttpPermission>;
  };
  const httpPermission = capability.permissions.find(
    (permission): permission is HttpPermission =>
      typeof permission === "object" && permission.identifier === "http:default",
  );

  return httpPermission?.allow?.map(({ url }) => url) ?? [];
}

describe("Tauri HTTP capability scope", () => {
  const patterns = configuredHttpPatterns().map((pattern) => new URLPattern(pattern));
  const isAllowed = (url: string) => patterns.some((pattern) => pattern.test(url));

  it("allows HTTPS MCP servers on default and custom ports", () => {
    expect(isAllowed("https://mcp.notion.com/mcp")).toBe(true);
    expect(isAllowed("https://mcp.example.com:7443/mcp")).toBe(true);
  });

  it("allows plain HTTP only on loopback hosts, including custom ports", () => {
    expect(isAllowed("http://localhost:4700/mcp")).toBe(true);
    expect(isAllowed("http://dev.localhost:4700/mcp")).toBe(true);
    expect(isAllowed("http://127.0.0.1:4700/mcp")).toBe(true);
    expect(isAllowed("http://[::1]:4700/mcp")).toBe(true);
    expect(isAllowed("http://mcp.example.com:4700/mcp")).toBe(false);
  });
});
