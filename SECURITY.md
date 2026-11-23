# Security

## What this plugin can do

Agent Trace runs as an Orca **trusted worker** (Orca shows it as "Full access") because it reads
Claude Code and Codex transcript files from your home folder. It asks for four capabilities:
`agent:read`, `workspace:read`, `storage:own` and `settings:own`.

It is read-only: it writes no files and starts no processes. It makes network requests only to the
Agent Trace hubs listed in `~/.config/agent-trace/hubs.json`, and only when they are on your
tailnet (https on a `*.ts.net` name, or a Tailscale address in 100.64.0.0/10), with a bearer token.
With no such file it makes no network requests at all.

The hub (`hub/`) runs on another Orca host as that host's user. Both of its listeners bind to
127.0.0.1; the API is published to the tailnet with `tailscale serve` and every call needs the
token. It reads that host's transcripts the same way the plugin does, keeps only numbers, names
and ids from OpenTelemetry (no prompt text, tool input or output), and asks GitHub through the
host's existing `gh` sign-in (it holds no GitHub token).
The README's [Security and privacy](README.md#security-and-privacy) section says what is read,
shown and stored.

## Supported versions

Fixes go into the latest release only.

## Reporting a vulnerability

Please do not put the details in a public issue.

1. Use **Report a vulnerability** under the repository's
   [Security tab](https://github.com/jalarrea2/orca-agent-trace/security), if it is offered.
2. Otherwise open an issue that only says you have a security report, and a private channel will
   be arranged there.

Useful in a report: the plugin and Orca versions, your operating system, what you did, what you
saw, and a transcript line or event that reproduces it with anything private removed.

## In scope

- Text from a transcript, an Orca event or a workspace name that runs as script or changes the
  page in the plugin's view.
- The plugin reading or writing outside the transcript folders and its own storage, or reaching
  any host other than a configured tailnet hub.
- The hub answering without a valid token, listening beyond 127.0.0.1, or returning data outside
  the transcripts, OpenTelemetry usage and GitHub statistics it is meant to serve.
- A secret shown or stored that the masking described in the README should have caught.
- A transcript or stored value that makes the worker hang, crash or use memory without bound.

## Out of scope

- Anything that needs an attacker who can already run code as you or write to your home folder.
- Secrets in forms the masking does not claim to cover. Reports of common forms it misses are
  welcome as ordinary issues.
