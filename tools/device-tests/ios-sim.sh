#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-7781}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.herdr/herdr-relay/token}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT <= 65535 )) || { echo 'PORT must be 1–65535' >&2; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"
[[ -n "$TOKEN" ]] || { echo 'Token file is empty' >&2; exit 1; }
URL="$(TOKEN="$TOKEN" PORT="$PORT" node -e 'const u=new URL(`http://127.0.0.1:${process.env.PORT}/herdr-relay/`); u.searchParams.set("token",process.env.TOKEN); process.stdout.write(u.href)')"
RUNTIME="$(xcrun simctl list runtimes -j | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const r=JSON.parse(s).runtimes.filter(x=>x.isAvailable && x.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"));r.sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true}));if(!r.length)process.exit(1);console.log(r.at(-1).identifier)})')"
UDID="$(xcrun simctl list devices -j | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s).devices[process.argv[1]]||[];const a=d.filter(x=>x.name==="herdr-relay iPad Air" && x.isAvailable);if(a.length>1){console.error("Multiple matching simulators; resolve ambiguity in Simulator");process.exit(1)};if(a.length)console.log(a[0].udid)})' "$RUNTIME")"
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl create 'herdr-relay iPad Air' 'iPad Air (5th generation)' "$RUNTIME")"
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
open -a Simulator
xcrun simctl openurl "$UDID" "$URL"
mkdir -p "$ROOT/.tmp/devices"
printf 'Set the selected iPad to portrait and wait for the page, then press Enter. ' >&2
read -r
xcrun simctl io "$UDID" screenshot "$ROOT/.tmp/devices/ipad-portrait.png"
printf 'Rotate the selected iPad to landscape in Simulator, then press Enter. ' >&2
read -r
xcrun simctl io "$UDID" screenshot "$ROOT/.tmp/devices/ipad-landscape.png"
