#!/usr/bin/env bash
# Agent Trace hub on an Orca server (Linux with systemd, Node 22+, jq): lets the Agent Trace plugin
# on your computer show the agents that run on this server, with tokens, cost, subagents and
# orchestration. Idempotent. Run it on the server as the user that runs Orca (no sudo):
#   bash hub/install.sh                       (from a checkout of this repository)
#   curl -fsSL https://raw.githubusercontent.com/jalarrea2/orca-agent-trace/main/hub/install.sh | bash
#
# What it does:
#   1. fetches the hub (hub/ + src/ of github.com/jalarrea2/orca-agent-trace) at AGENT_TRACE_REF
#   2. creates a random bearer token (~/.config/agent-trace-hub/token, 0600) if there is none
#   3. installs and starts the systemd user service agent-trace-hub (API 127.0.0.1:7787, OTLP 127.0.0.1:4318)
#   4. points Claude Code and Codex OpenTelemetry at the local receiver (usage only: prompts,
#      tool input and responses are not exported)
# Publishing the API to the tailnet needs sudo: run hub/tailscale-serve.sh once as a user with sudo.
# Then pair your computer with scripts/pair.sh.
#
#   AGENT_TRACE_REF=main          git ref of orca-agent-trace to install
#   AGENT_TRACE_SRC=/path         install from a local checkout instead of GitHub (default: this
#                                 checkout, when the script is run from one)
#   AGENT_TRACE_WORKSPACES=/path  Orca workspaces root, <root>/<project>/<workspace> (default ~/orca/workspaces)
#   AGENT_CONFIG=0                skip step 4 (agent OpenTelemetry settings)
set -euo pipefail
log() { printf '[agent-trace-hub] %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

[ "$(id -u)" != 0 ] || die "run as the orca user, not root"
REF="${AGENT_TRACE_REF:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "${AGENT_TRACE_SRC:-}" ] && [ -n "$HERE" ] && [ -f "$HERE/server.mjs" ] && [ -d "$HERE/../src" ]; then
  AGENT_TRACE_SRC="$(cd "$HERE/.." && pwd)"
fi
REPO="https://github.com/jalarrea2/orca-agent-trace.git"
APP="$HOME/.local/share/agent-trace-hub"
CONF="$HOME/.config/agent-trace-hub"
UNIT="$HOME/.config/systemd/user/agent-trace-hub.service"
API_PORT="${AGENT_TRACE_HUB_PORT:-7787}"
OTLP_PORT="${AGENT_TRACE_OTLP_PORT:-4318}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found on PATH (Node 22+ is needed)"
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node 22+ is needed, found $("$NODE" --version)"
command -v jq >/dev/null || die "jq is needed"

log "1/4 hub code ($REF)"
mkdir -p "$APP"
if [ -n "${AGENT_TRACE_SRC:-}" ]; then
  [ -f "$AGENT_TRACE_SRC/hub/server.mjs" ] || die "AGENT_TRACE_SRC has no hub/server.mjs"
  rm -rf "$APP/src.new" && mkdir -p "$APP/src.new"
  cp -R "$AGENT_TRACE_SRC/hub" "$AGENT_TRACE_SRC/src" "$AGENT_TRACE_SRC/package.json" "$AGENT_TRACE_SRC/LICENSE" "$APP/src.new/"
  rm -rf "$APP/src" && mv "$APP/src.new" "$APP/src"
else
  if [ ! -d "$APP/src/.git" ]; then rm -rf "$APP/src"; git clone -q "$REPO" "$APP/src"; fi
  git -C "$APP/src" fetch -q origin "$REF"
  git -C "$APP/src" checkout -q --detach FETCH_HEAD
fi
[ -f "$APP/src/hub/server.mjs" ] || die "hub/server.mjs missing in $APP/src (ref $REF has no hub?)"

log "2/4 token"
install -d -m 0700 "$CONF"
if [ ! -s "$CONF/token" ]; then
  (umask 077; "$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$CONF/token")
  log "new token in $CONF/token (not printed)"
fi
chmod 0600 "$CONF/token"

log "3/4 systemd user service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=Agent Trace hub (transcripts + OpenTelemetry for the Agent Trace plugin)
After=network-online.target

[Service]
ExecStart=$NODE $APP/src/hub/server.mjs
Environment=AGENT_TRACE_HUB_PORT=$API_PORT
Environment=AGENT_TRACE_OTLP_PORT=$OTLP_PORT
${AGENT_TRACE_WORKSPACES:+Environment=AGENT_TRACE_WORKSPACES=$AGENT_TRACE_WORKSPACES}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=512M

[Install]
WantedBy=default.target
EOF
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
systemctl --user enable -q agent-trace-hub.service
systemctl --user restart agent-trace-hub.service

if [ "${AGENT_CONFIG:-1}" = 1 ]; then
  log "4/4 agent OpenTelemetry -> 127.0.0.1:$OTLP_PORT"
  settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  [ -s "$settings" ] || echo '{}' > "$settings"
  jq empty "$settings" || die "$settings is not valid JSON; fix it first (an invalid file hangs every Claude agent)"
  cp "$settings" "$settings.bak-agent-trace"
  jq --arg ep "http://127.0.0.1:$OTLP_PORT" '.env = ((.env // {}) + {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: $ep
    })' "$settings.bak-agent-trace" > "$settings.new"
  jq empty "$settings.new" && mv "$settings.new" "$settings"
  codex="$HOME/.codex/config.toml"
  mkdir -p "$HOME/.codex" && touch "$codex"
  if ! grep -q '^\[otel\]' "$codex"; then
    cp "$codex" "$codex.bak-agent-trace"
    printf '\n[otel]\nenvironment = "%s"\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:%s/v1/logs", protocol = "json" } }\n' "$(hostname -s)" "$OTLP_PORT" >> "$codex"
  else
    log "codex: [otel] already present in $codex, left as is"
  fi
  log "new agent sessions export usage; running sessions keep their old settings"
else
  log "4/4 skipped (AGENT_CONFIG=0)"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -H "Authorization: Bearer $(cat "$CONF/token")" "http://127.0.0.1:$API_PORT/v1/health" >/dev/null 2>&1; then
    log "ok: hub answers on 127.0.0.1:$API_PORT"
    exit 0
  fi
  sleep 1
done
journalctl --user -u agent-trace-hub -n 20 --no-pager >&2 || true
die "the hub did not answer on 127.0.0.1:$API_PORT"
