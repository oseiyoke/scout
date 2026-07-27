# Scout application

The desktop application lives here. See the [repository README](../README.md) for setup, security, privacy, and contribution guidance.

Scout connects to remote Streamable HTTP MCP servers. Built-in providers use their documented endpoints; any private or self-hosted service can be added through **Add custom** with OAuth, a bearer token, or custom headers. Loopback HTTP endpoints are supported for local development, while remote endpoints must use HTTPS.

Every external write is shown with its exact connector, tool, and arguments and requires explicit approval. Browser access and persisted model diagnostics are disabled by default.

```bash
npm install
npm run check
npm run tauri dev
```
