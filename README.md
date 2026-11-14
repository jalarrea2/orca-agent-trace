# Agent Trace

An [Orca](https://orca.dev) plugin: a live, animated run view of your agents.

![Agent Trace showing two active workspaces as a tree of agent cards above a trace timeline](assets/cover.png)

*Screenshots use invented sample data.*

By default it shows **every active workspace** at once: Orca → workspaces → agents → subagents,
each card with its state, model, tokens, estimated cost and duration. Below the tree: a trace
timeline of model turns and tool calls, a tokens and cost table, and an event log. A workspace is
active while one of its agents is running or waiting on you, and for 15 minutes after its last
agent activity. The first selector switches to the focused workspace or to one workspace by name.

It is read-only (it never sends anything to an agent) and local (no network requests).

Motion: running cards breathe and carry a sweeping light, connectors into a running agent flow
(amber when it waits on you), running bars are striped and grow, and durations count up every
second between polls. `prefers-reduced-motion` turns it off.

It shows up in two places:

- **Right sidebar panel** "Agent Trace". Widen the sidebar for the tree layout; narrow, it is an
  indented list.
- **Editor tab**: tab bar **+** → **New Agent Trace view**. This creates an `untitled.agenttrace`
  file in the workspace folder and opens it in the plugin's editor (see Known limits).

## Status

Early: version 0.2, built in two days and used on one machine. Not yet listed in Orca's plugin
directory. Expect rough edges, and please open an issue with what you see.

## Install

Requires Orca **1.4.248 or later**, desktop app.

```sh
orca plugin install jalarrea2/orca-agent-trace
```

Or clone this repository and add the folder under Settings → Plugins → ⋯ → **Development
folders…**, then review and enable it.

Orca shows it as **Full access**: the worker is a Node program that reads transcript files on
your disk. Capabilities asked: `agent:read`, `workspace:read`, `storage:own`, `settings:own`.

## Where the data comes from

| Layer | Source | Agents | Gives |
| --- | --- | --- | --- |
| Status | `agent.status.changed` event, `agents.list` | Any agent Orca runs | Running / Needs you / Waiting / Done / Failed, time in each state |
| Tool calls | `agent.tool.after` hook (observe only) | Any agent that reports tool calls to Orca | Tool name, short label, when it finished |
| Transcripts | `~/.claude/projects`, `~/.codex/sessions` | Claude Code, Codex | Model turns, tool call durations and failures, tokens, estimated cost, Claude Code subagents |

An agent with no transcript adapter (Gemini, OpenCode, Cursor, ...) appears as an **Events only**
card: state, working time and tool ticks, but no tokens or cost.

Orca has no parent/child relation between agents in different terminals, so the sessions of a
workspace sit side by side under it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Default time range | Last 6 hours | How far back a one-workspace view looks when it opens (the all-workspaces view opens on the last hour) |
| Show tool call labels | On | Label calls with the file name, command start or web host; off keeps only the tool name |
| Claude Code folder | `~/.claude` | Folder that holds `projects/` |
| Codex folder | `~/.codex` | Folder that holds `sessions/` |

## What is stored

Only Orca's own events, in the plugin's private storage (`storage:own`), so the timeline survives
a worker restart: per terminal pane, its state changes and the name and short label of each tool
call, for 7 days. No prompt text, tool input or tool output is stored. Transcripts are read in
place and never copied. Nothing leaves your machine: the view frame has no network access and the
worker makes no network requests.

## Known limits

- **Lightly tested.** In Orca it has drawn real Codex and Claude Code sessions across several
  workspaces. Subagents and events-only agents have only been run against the stand-in host in
  `tests/`.
- **Each "New Agent Trace view" creates a file.** Orca writes `untitled.agenttrace` into the
  workspace folder, where git sees it as untracked. Add `*.agenttrace` to your global gitignore
  so an agent's `git add -A` does not pick it up.
- **Agents of unfocused workspaces can land under "Other agents".** Before host API 1.7 an event
  names its workspace by a raw id that differs from the one `workspace.list` gives. The worker
  learns the pairing when you focus a workspace and also tries the worktree path; an agent it
  still cannot place is listed under "Other agents". Claude Code and Codex sessions are placed by
  their folder, so this only affects events-only agents and live state.
- **The all-workspaces view stats every Claude Code session file of every workspace on each
  poll** (every 3 s). With hundreds of worktrees, watch the worker's CPU.
- **Pane ↔ transcript matching is by time** on Orca ≤ 1.4.258, which does not report a session id
  on status events. Two sessions of the same agent that start within seconds of each other in one
  workspace can swap panes (state shown on the wrong card; tokens stay right).
- **Transcript formats are not a contract.** The Claude Code and Codex field names are listed at
  the top of each adapter; a new CLI version can change them.
- **Cost is an estimate** from `src/core/prices-data.mjs` (snapshot of 2026-11-12, Anthropic and
  OpenAI models), not a bill. A model missing from the table shows "no price"; totals then carry
  a `+`.
- **Tool calls of events-only agents are ticks**, not bars: Orca reports when a call finished,
  not when it started. Starting times would need the `agent.tool.before` hook, which makes Claude
  Code wait for the plugin on every call, so it is left out.
- **Session titles are the first prompt.** For sessions started by an automation that is often
  boilerplate.
- **Local machine only.** Workspaces on SSH or paired hosts show state but no transcripts.
- No pause or stop controls.

## When host API 1.8 and 1.9 ship

They add a session id to status events and `agent.listSessions` (title and total tokens of every
agent's sessions, behind `history:read`). The matching code already prefers a session id when one
arrives. To get token totals for events-only agents, add `{ "kind": "history:read" }` to
`capabilities`, raise `engines.orca`, and fill `tokens` for unmatched panes in
`src/core/snapshot.mjs` from `agent.listSessions`.

## Layout

```
orca-plugin.json            manifest (format 2)
src/worker.mjs              the only file that knows Orca: events, hook, panel handler, storage
src/core/live.mjs           agent-agnostic store of Orca's events
src/core/adapters/*.mjs     transcript lines → normalized session (claude, codex)
src/core/snapshot.mjs       sessions + live panes → what the view draws
src/core/pricing.mjs        cost from the local price table
src/node/transcripts.mjs    finds each workspace's transcripts, reads only appended bytes
view/                       panel (index.html) and editor tab (editor.html), no framework
dev/preview.html            the view in a plain browser, over invented data
tests/                      node --test
```

## Add an agent

1. Write `src/core/adapters/<agent>.mjs` exporting a parser with `push(line)` and `result()`, where
   `result()` returns `{ agentKind, sessionId, cwd, title, agents, events }` in the shape
   `claude.mjs` returns (helpers in `adapters/shared.mjs`).
2. In `src/node/transcripts.mjs`, add how to find that agent's files for a workspace folder and
   call `readSession('<agent>', sessionId, files)`.
3. Add a fixture and a test in `tests/`.

## Develop

```sh
npm test                    # node --test: adapters, pricing, live store, snapshots, worker
npm run preview             # then open http://localhost:8765/dev/preview.html (?theme=dark)
orca plugin validate .      # manifest and file checks, as Orca runs them
orca plugin dev watch .     # load as local.agent-trace, reload on save, print logs
```

## Credits and license

MIT, see [LICENSE](LICENSE). The price table is derived from
[orca-usage-insights](https://github.com/Etherll/orca-usage-insights) (MIT); see
[NOTICE.md](NOTICE.md). Not affiliated with Orca or Stably.
