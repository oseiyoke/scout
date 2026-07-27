export function isLoopbackMcpUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "127.0.0.1"
      || hostname.startsWith("127.")
      || hostname === "[::1]"
      || hostname === "::1";
  } catch {
    return false;
  }
}

/** Remote MCP traffic must be HTTPS; RFC 8252 loopback development may use HTTP. */
export function isAllowedMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackMcpUrl(value));
  } catch {
    return false;
  }
}
