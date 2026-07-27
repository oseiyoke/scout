# Scout

Scout is a local-first Tauri desktop assistant. It reads user-connected sources through MCP, identifies work that may need attention, and presents exact actions for review. It never performs an external write without explicit approval.

## Status

Scout is early-stage software. Review proposed tool arguments carefully, use test accounts while evaluating connectors, and report security issues privately as described in [SECURITY.md](SECURITY.md).

## Build from source

Requirements: Node.js 24, stable Rust, and the platform prerequisites for Tauri 2.

```bash
cd scout-app
npm ci
npm run check
npm run tauri dev
```

Production builds use `npm run tauri build`. API keys and connector credentials are entered in the app and stored in the operating system credential vault; do not place secrets in `VITE_*` variables because Vite embeds those values in frontend bundles.

## Security and privacy

- Every write action displays the connector, tool, and JSON arguments before approval.
- Approval captures an immutable plan; execution validates the current tool and input schema again.
- Browser sweeps and diagnostic prompt retention are off by default.
- Remote custom MCP endpoints must use HTTPS; loopback HTTP is allowed for development.
- Local application history is stored in SQLite and is not encrypted by Scout. Credentials are stored separately in the OS credential vault.

See [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Contributions are welcome under the [MIT License](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.
