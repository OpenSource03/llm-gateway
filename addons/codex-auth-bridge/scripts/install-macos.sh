#!/usr/bin/env bash
set -euo pipefail

label="io.opensource03.llm-gateway.codex-auth-bridge"
listen_address="127.0.0.1:43817"
upstream_url="http://127.0.0.1:3001/api/llm-gateway"
keychain_account="${USER:-}"
keychain_service="LLM Gateway"
source_binary=""

usage() {
  cat <<'EOF'
Usage: install-macos.sh [options]

  --binary PATH              Install a prebuilt macOS binary
  --listen ADDRESS           Loopback listener (default 127.0.0.1:43817)
  --upstream URL             Fixed LLM Gateway base URL
  --keychain-account NAME    macOS Keychain account (default current user)
  --keychain-service NAME    macOS Keychain service (default LLM Gateway)
EOF
}

while (($#)); do
  case "$1" in
    --binary)
      source_binary="${2:?missing value for --binary}"
      shift 2
      ;;
    --listen)
      listen_address="${2:?missing value for --listen}"
      shift 2
      ;;
    --upstream)
      upstream_url="${2:?missing value for --upstream}"
      shift 2
      ;;
    --keychain-account)
      keychain_account="${2:?missing value for --keychain-account}"
      shift 2
      ;;
    --keychain-service)
      keychain_service="${2:?missing value for --keychain-service}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer supports macOS only." >&2
  exit 1
fi
if [[ -z "$keychain_account" ]]; then
  echo "Could not determine the Keychain account; pass --keychain-account." >&2
  exit 1
fi
if [[ ! "$listen_address" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]]; then
  echo "--listen must use an explicit 127.0.0.1 address." >&2
  exit 1
fi

port="${BASH_REMATCH[1]}"
if ((port < 1 || port > 65535)); then
  echo "--listen must contain a valid non-zero port." >&2
  exit 1
fi
user_id="$(id -u)"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="$HOME/Library/Application Support/LLM Gateway"
install_binary="$install_root/codex-auth-bridge"
log_root="$HOME/Library/Logs/LLM Gateway"
plist="$HOME/Library/LaunchAgents/$label.plist"
service_target="gui/$user_id/$label"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codex-auth-bridge.XXXXXX")"

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

xml_escape() {
  printf '%s' "$1" |
    sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

/usr/bin/security find-generic-password \
  -a "$keychain_account" \
  -s "$keychain_service" \
  -w >/dev/null

if [[ -z "$source_binary" ]]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "Go is required when --binary is not provided." >&2
    exit 1
  fi
  source_binary="$temporary_directory/codex-auth-bridge"
  (
    cd "$script_root"
    CGO_ENABLED=0 go build -trimpath -o "$source_binary" ./cmd/codex-auth-bridge
  )
elif [[ ! -f "$source_binary" ]]; then
  echo "Bridge binary not found: $source_binary" >&2
  exit 1
fi
if ! "$source_binary" --help >/dev/null 2>&1; then
  echo "Bridge binary could not execute on this Mac." >&2
  exit 1
fi

escaped_binary="$(xml_escape "$install_binary")"
escaped_listen="$(xml_escape "$listen_address")"
escaped_upstream="$(xml_escape "$upstream_url")"
escaped_account="$(xml_escape "$keychain_account")"
escaped_service="$(xml_escape "$keychain_service")"
escaped_stdout="$(xml_escape "$log_root/stdout.log")"
escaped_stderr="$(xml_escape "$log_root/stderr.log")"

temporary_plist="$temporary_directory/$label.plist"
cat >"$temporary_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_binary</string>
    <string>--listen</string>
    <string>$escaped_listen</string>
    <string>--upstream</string>
    <string>$escaped_upstream</string>
    <string>--keychain-account</string>
    <string>$escaped_account</string>
    <string>--keychain-service</string>
    <string>$escaped_service</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$escaped_stdout</string>
  <key>StandardErrorPath</key>
  <string>$escaped_stderr</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "$temporary_plist" >/dev/null
launchctl bootout "gui/$user_id" "$plist" >/dev/null 2>&1 || true

if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is already in use." >&2
  exit 1
fi

install -d -m 700 "$install_root" "$log_root"
install -d -m 700 "$HOME/Library/LaunchAgents"
install -m 755 "$source_binary" "$install_binary"
install -m 600 "$temporary_plist" "$plist"
launchctl bootstrap "gui/$user_id" "$plist"
launchctl enable "$service_target"
launchctl kickstart -k "$service_target"

for _ in {1..40}; do
  if /usr/bin/curl --fail --silent --max-time 1 \
    "http://$listen_address/_llmgw/health" >/dev/null; then
    echo "Codex authentication bridge is ready at http://$listen_address"
    exit 0
  fi
  sleep 0.25
done

echo "Bridge did not become ready. Inspect $log_root/stderr.log" >&2
exit 1
