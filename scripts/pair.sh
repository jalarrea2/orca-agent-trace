#!/usr/bin/env bash
# Run on your computer: registers an Orca server's Agent Trace hub with the Agent Trace plugin by
# writing ~/.config/agent-trace/hubs.json (0600). The token goes from the server file straight into
# that file over SSH and is never printed.
#   scripts/pair.sh <ssh-host> [orca-environment-id] [server-orca-user]
# The ssh host must reach the server; the hub runs as the user that runs Orca there (default: the
# ssh user, or AGENT_TRACE_SERVER_USER).
# The environment id is the saved Orca server (`orca environment list`); Orca names remote
# workspaces with it, and the plugin uses it to pick the hub.
set -euo pipefail
HOST="${1:?usage: scripts/pair.sh <ssh-host> [orca-environment-id] [server-orca-user]}"
ENV_ID="${2:-}"
RUN_AS="${3:-${AGENT_TRACE_SERVER_USER:-}}"
HTTPS_PORT="${AGENT_TRACE_HUB_HTTPS_PORT:-8443}"
command -v jq >/dev/null || { echo "jq is needed" >&2; exit 1; }
if [ -z "$ENV_ID" ]; then
  ENV_ID="$(orca environment list --json 2>/dev/null | jq -r --arg h "$HOST" '.result.environments[]? | select(.name == $h) | .id' | head -1)"
fi
[ -n "$ENV_ID" ] || { echo "Orca environment id for $HOST not found; pass it as the second argument" >&2; exit 1; }
DNS="$(ssh "$HOST" "tailscale status --json" | jq -r '.Self.DNSName | rtrimstr(".")')"
[ -n "$DNS" ] && [ "$DNS" != null ] || { echo "could not read the server's tailnet name" >&2; exit 1; }
FILE="$HOME/.config/agent-trace/hubs.json"
mkdir -p "$(dirname "$FILE")"
umask 077
tmp="$(mktemp "$FILE.XXXX")"
trap 'rm -f "$tmp"' EXIT
existing="$( [ -s "$FILE" ] && cat "$FILE" || echo '[]')"
if [ -n "$RUN_AS" ]; then read_token="sudo -iu $RUN_AS cat .config/agent-trace-hub/token"; else read_token="cat .config/agent-trace-hub/token"; fi
ssh "$HOST" "$read_token" \
  | jq -R --argjson list "$existing" --arg name "$HOST" --arg url "https://$DNS:$HTTPS_PORT" --arg env "$ENV_ID" \
      '($list | map(select(.name != $name))) + [{name: $name, url: $url, hostIds: [$env], token: .}]' > "$tmp"
mv "$tmp" "$FILE"
trap - EXIT
chmod 600 "$FILE"
echo "Wrote $FILE: $HOST -> https://$DNS:$HTTPS_PORT (Orca environment $ENV_ID)"
