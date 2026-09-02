#!/usr/bin/env bash
set -euo pipefail

label="io.opensource03.llm-gateway.codex-auth-bridge"
user_id="$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
install_root="$HOME/Library/Application Support/LLM Gateway"

launchctl bootout "gui/$user_id" "$plist" >/dev/null 2>&1 || true
rm -f "$plist" "$install_root/codex-auth-bridge"
rmdir "$install_root" >/dev/null 2>&1 || true

echo "Codex authentication bridge removed. Lifecycle logs were retained."
