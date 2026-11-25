#!/usr/bin/env bash
# Publishes the Agent Trace hub API to the tailnet only (never the internet), over HTTPS with the
# machine's *.ts.net certificate (HTTPS certificates must be enabled for the tailnet). Run once on
# the server as a user with sudo:
#   bash hub/tailscale-serve.sh
# Undo: sudo tailscale serve --https=8443 off
set -euo pipefail
PORT="${AGENT_TRACE_HUB_PORT:-7787}"
HTTPS_PORT="${AGENT_TRACE_HUB_HTTPS_PORT:-8443}"
sudo tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"
tailscale serve status
echo "Tailnet URL: https://$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'):$HTTPS_PORT"
