# Third-party notices

Scout is distributed under the MIT License and includes third-party dependencies under their own licenses. JavaScript and Rust dependency metadata is recorded in `package-lock.json` and `Cargo.lock`.

The bundled Chrome integration includes Node.js and `chrome-devtools-mcp`; their license files and notices must remain with binary distributions. The dependency graph also includes permissive MIT, Apache-2.0, BSD, and ISC packages, plus packages under MPL-2.0 and CC-BY-4.0. Those licenses apply only to their respective components.

Before each release, regenerate the dependency inventory, review new or changed licenses, preserve required notices, and confirm that the bundled runtime's license files are present in the final artifact.
