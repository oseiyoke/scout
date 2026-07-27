# Releasing

1. Review Dependabot updates and run the complete CI suite on every supported desktop platform.
2. Audit JavaScript and Rust dependencies, licenses, and bundled runtime notices.
3. Build from a clean tagged commit using Tauri's platform signing and notarization credentials. Never place signing keys in the repository.
4. Test install, upgrade, OAuth callbacks, credential deletion, browser opt-in, exact-plan approval, and complete data deletion.
5. Publish checksums, release notes, known limitations, and signed artifacts through GitHub Releases.

Do not publish unsigned production artifacts as official releases. Configure Apple Developer ID/notarization, Windows code-signing, and Linux packaging credentials in the release environment before automating distribution.
