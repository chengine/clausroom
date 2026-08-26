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

When run through SSH, the CLI prints a private browser URL and a
`clausroom ssh setup ...` command for the browser machine. The user supplies
their normal SSH destination; Clausroom adds only a persistent loopback forward.

Configuration is project-local in `clausroom.toml`. Runtime credentials are in a
mode-0600 session file on POSIX (the user profile on Windows) and are removed on exit.
