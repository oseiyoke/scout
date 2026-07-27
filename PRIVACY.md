# Privacy

Scout runs on the user's device. Connected-source content is sent to the model provider selected by the user so Scout can plan reads and generate proposals. Connector requests go to the MCP endpoints the user enables.

Scout stores settings, connector metadata, sweep history, proposals, and decisions in a local SQLite database. That database is not encrypted by Scout. API keys, OAuth tokens, bearer tokens, and custom headers are stored in the operating system credential vault. Model prompts, output, and reasoning are not retained unless **Store model diagnostics** is enabled.

Chrome access is optional and sweep access is disabled by default. Scout exposes a constrained browser tool set and does not intentionally expose cookies, saved passwords, or browser history.

The Data settings page can copy a JSON export, delete selected history, or delete all Scout data and credentials from the device. Backups made by the operating system are outside Scout's control.
