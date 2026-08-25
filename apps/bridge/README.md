# clausroom CLI

Install from the repository root with `npm run install:cli`. Then, from the
project your agent should use:

```bash
clausroom host --agent codex --auto
# or
clausroom connect --agent claude --auto
```

The browser performs the manual WebRTC offer/answer exchange. Both commands bind
only loopback and stay running for the room's lifetime.

When run through SSH, the CLI prints a private browser URL and an exact one-time
`clausroom ssh add ...` command for the browser machine. That helper creates a
loopback-only `LocalForward` using the user's existing SSH authentication.

Configuration is project-local in `clausroom.toml`. Runtime credentials are in a
mode-0600 session file on POSIX (the user profile on Windows) and are removed on exit.
