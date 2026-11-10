#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
AVDMANAGER="${AVDMANAGER:-$SDK/cmdline-tools/latest/bin/avdmanager}"
EMULATOR="${EMULATOR:-$SDK/emulator/emulator}"
ADB="${ADB:-$SDK/platform-tools/adb}"
PORT="${PORT:-7781}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.herdr/herdr-relay/token}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT <= 65535 )) || { echo 'PORT must be 1–65535' >&2; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"
[[ -n "$TOKEN" ]] || { echo 'Token file is empty' >&2; exit 1; }
if ! "$EMULATOR" -list-avds | grep -Fxq 'herdr-relay'; then
  DEVICE=pixel_tablet
  if ! "$AVDMANAGER" list device -c | grep -Fxq "$DEVICE"; then DEVICE=pixel_7; fi
  printf 'no\n' | "$AVDMANAGER" create avd -n herdr-relay -k 'system-images;android-35;google_apis;arm64-v8a' -d "$DEVICE"
fi
find_emulator() {
  local serial name found=''
  while read -r serial state _; do
    [[ "$serial" == emulator-* && "$state" == device ]] || continue
    name="$("$ADB" -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | first_line)"
    if [[ "$name" == herdr-relay ]]; then
      [[ -z "$found" ]] || { echo 'Multiple herdr-relay emulators are running' >&2; return 1; }
      found="$serial"
    fi
  done < <("$ADB" devices)
  printf '%s' "$found"
}
first_line() { IFS= read -r line || true; printf '%s' "$line"; cat >/dev/null; }
SERIAL="$(find_emulator)"
if [[ -z "$SERIAL" ]]; then
  "$EMULATOR" -avd herdr-relay -no-snapshot -no-boot-anim >/dev/null 2>&1 &
  PID=$!
  for ((i=0; i<120; i++)); do
    SERIAL="$(find_emulator)"
    [[ -n "$SERIAL" ]] && break
    kill -0 "$PID" 2>/dev/null || { echo 'Emulator exited before connecting' >&2; exit 1; }
    sleep 1
  done
fi
[[ -n "$SERIAL" ]] || { echo 'Timed out waiting for the herdr-relay emulator' >&2; exit 1; }
"$ADB" -s "$SERIAL" wait-for-device
for ((i=0; i<180; i++)); do
  [[ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] && break
  sleep 1
done
(( i < 180 )) || { echo 'Timed out waiting for Android boot' >&2; exit 1; }
"$ADB" -s "$SERIAL" reverse "tcp:$PORT" "tcp:$PORT"
URL="$(TOKEN="$TOKEN" PORT="$PORT" node -e 'const u=new URL(`http://127.0.0.1:${process.env.PORT}/herdr-relay/`);u.searchParams.set("token",process.env.TOKEN);process.stdout.write(u.href)')"
"$ADB" -s "$SERIAL" shell am start -a android.intent.action.VIEW -d "$URL"
mkdir -p "$ROOT/.tmp/devices"
printf 'Wait for the Android page to load, then press Enter to capture it. ' >&2
read -r
"$ADB" -s "$SERIAL" exec-out screencap -p > "$ROOT/.tmp/devices/android.png"
