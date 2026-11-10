import { View, div } from "gpui-kit";
import { appHome, exec, home } from "herdr";

const listing = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
const picture = 'mkdir -p "$(dirname "$1")" && { [ -s "$1" ] || curl -fsSL --max-time 20 -o "$1" "$2"; } && sips -g pixelWidth -g pixelHeight "$1"';

export default class Probe extends View {
  render() {
    const app = appHome();
    const user = home();
    for (const [command, args] of [
      ["node", [`${app}/mods/lstack-herdr/components/lh-scan.mjs`, "tree"]],
      ["node", [`${app}/mods/lstack-herdr/sync.mjs`, "--json"]],
      ["env", [`HOME=${user}`, `HERDR_APP_HOME=${app}`, "COCKPIT_FRONTEND=app", `${user}/.local/bin/cockpit`, "hub", "start"]],
      ["sh", ["-c", listing, "files", app]],
      ["sh", ["-c", picture, "sh", `${app}/data/cockpit/show/picture`, "https://example.com/image.png"]],
    ]) exec(command, args).catch(() => {});
    return div();
  }
}
