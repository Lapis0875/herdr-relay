import { assert, assertEquals } from "@std/assert";
import type { JsonObject } from "@herdr-relay/protocol";
import type { CoreTerminal } from "../../../src/core/mod.ts";
import { programOf, programTable, startable } from "../../../src/herdr/model.ts";
import { assetContentType } from "../../../src/policy/read.ts";
import bundled from "../../../src/herdr/programs.json" with { type: "json" };

/** Herdr 0.1.14's `defaults/programs.json`, as synced from upstream. */
const SHIPPED = JSON.parse(await Deno.readTextFile("fixtures/generic-home/programs.json"));

/** A core terminal record with what `programOf` reads. */
function terminal(argv: string[], extra: { app?: string; foreground?: string[] } = {}): CoreTerminal {
  return {
    address: "t1",
    labels: {},
    argv,
    cwd: "/",
    state: "live",
    created_ms: 0,
    screen: "exact",
    cols: 80,
    rows: 24,
    status: extra.app ? { state: "working", app: extra.app } : null,
    foreground: extra.foreground ? { argv: extra.foreground, cwd: "/", name: "x", pid: 1 } : undefined,
  };
}

const table = programTable({});
const key = (argv: string[], app?: string) => programOf(table, terminal(argv, { app })).key;

Deno.test("the bundled built-in table is Herdr's defaults/programs.json", () => {
  const { $comment: _, ...table } = bundled;
  assertEquals(table, SHIPPED);
});

Deno.test("every built-in icon is an icons/ file the asset route serves", async () => {
  for (const [name, e] of Object.entries(SHIPPED.programs as Record<string, { icon: string }>)) {
    assertEquals(assetContentType(e.icon), "image/svg+xml", name);
    assert((await Deno.stat(`fixtures/generic-home/${e.icon}`)).isFile, `${name}: ${e.icon}`);
  }
});

Deno.test("agents, shells, tools and what interpreters run resolve as in Herdr", () => {
  // herdr-app v0.1.14 src/programs.rs `agents_shells_tools_and_what_interpreters_run`.
  assertEquals(key(["/bin/zsh"], "claude-code"), "claude");
  assertEquals(key(["/bin/zsh"], "grok-build"), "grok");
  assertEquals(key(["/bin/zsh"], "dsh-tui"), "dsh-tui");
  assertEquals(key(["dsh-tui"]), "dsh-tui");
  assertEquals(key([], "newagent"), "agent");
  assertEquals(key(["/bin/zsh"]), "shell");
  assertEquals(key(["-zsh"]), "shell");
  assertEquals(key(["nvim", "x.rs"]), "nvim");
  assertEquals(key(["vi"]), "vim");
  assertEquals(key(["node", "/x/node_modules/.bin/vite", "dev"]), "vite");
  assertEquals(key(["npx", "vitest"]), "vitest");
  assertEquals(key(["node", "server.js"]), "node");
  assertEquals(key(["python3", "-m", "http.server", "8799"]), "python");
  assertEquals(key(["uv", "run", "pytest"]), "pytest");
  assertEquals(key(["mytool"]), "program");
  assertEquals(key(["/bin/zsh", "-ic", '"$@"; exec "$0" -i', "/bin/zsh", "vi", "x"]), "vim");
  assertEquals(
    key(["/usr/bin/fish", "-ic", "command $argv[2..]; exec $argv[1] -i", "/usr/bin/fish", "vi", "x"]),
    "vim",
  );
  assertEquals(key(["pwsh.exe", "-NoExit", "-Command", "& 'codex' 'fix it'"]), "codex");
  assertEquals(key(["C:\\Windows\\powershell.exe"]), "shell");
});

Deno.test("a terminal shows what runs now, with the icon, tint and tile Herdr draws", () => {
  const now = (argv: string[], foreground: string[]) => programOf(table, terminal(argv, { foreground }));
  assertEquals(now(["/bin/zsh", "-l"], ["deno", "task", "herdr-relay", "start"]), {
    key: "deno",
    name: "Deno",
    icon: "icons/deno.svg",
    tint: true,
    tile: "#1c1d21",
    color: "#ffffff",
    shell: false,
    agent: false,
  });
  assertEquals(now(["/bin/zsh", "-l"], ["node", "/opt/homebrew/bin/npm", "run", "build"]).icon, "icons/npm.svg");
  assertEquals(now(["/bin/zsh", "-l"], ["/bin/zsh", "-l"]), {
    key: "shell",
    name: "zsh",
    icon: "icons/shell.svg",
    tint: true,
    tile: "#16241a",
    color: "#4ec95f",
    shell: true,
    agent: false,
  });
  // No foreground: what it started with.
  assertEquals(
    programOf(table, terminal(["/Users/sam/.local/bin/claude", "--model", "haiku"])).icon,
    "icons/claude.svg",
  );
  // Unlisted: the `program` glyph on a tile of its own (FNV-1a of the name).
  assertEquals(now(["/bin/zsh", "-l"], ["npm start", "", ""]), {
    key: "program",
    name: "npm start",
    icon: "icons/program.svg",
    tint: true,
    tile: "#8a5a44",
    color: "#ffffff",
    shell: false,
    agent: false,
  });
  assertEquals(key(["mytool"]), "program");
  assertEquals(programOf(table, terminal(["mytool"])).tile, "#3a7d44");
});

Deno.test("the person's programs.json changes entries field by field and adds to the lists", () => {
  const mine = programTable({
    shells: ["myshell"],
    interpreters: ["runner"],
    programs: {
      omp: { name: "OMP", icon: "my-icons/omp.svg", tint: false, tile: "#0f0a14", run: ["omp"] },
      lazygit: { name: "Git", tile: "#f05032" },
      claude: { run: ["my-claude"], icon: null },
    },
  } as JsonObject);
  assertEquals(programOf(mine, terminal(["/bin/zsh", "-l"], { app: "omp" })), {
    key: "omp",
    name: "OMP",
    icon: "my-icons/omp.svg",
    tint: false,
    tile: "#0f0a14",
    color: null,
    shell: false,
    agent: true,
  });
  const git = programOf(mine, terminal(["lazygit"]));
  assertEquals([git.name, git.icon, git.tile], ["Git", "icons/lazygit.svg", "#f05032"]);
  const claude = startable(mine).find((p) => p.key === "claude")!;
  assertEquals([claude.run, claude.icon, claude.agent], [["my-claude"], "icons/claude.svg", true]);
  assertEquals(programOf(mine, terminal(["myshell"])).key, "shell");
  assertEquals(programOf(mine, terminal(["runner", "vite"])).key, "vite");
  assertEquals(programOf(mine, terminal(["zsh"])).key, "shell");
});

Deno.test("a programs.json Herdr cannot read leaves the built-in table", () => {
  const unreadable: JsonObject[] = [
    { programs: { x: { name: 1 } } },
    { shells: "zsh" },
    { programs: [] },
    { programs: { x: { match: [1] } } },
  ];
  for (const file of unreadable) {
    const t = programTable(file);
    assertEquals(t.entries.has("x"), false);
    assertEquals(programOf(t, terminal(["deno"])).icon, "icons/deno.svg");
  }
});

Deno.test("startable agents list the most picked first, then the rest by key", () => {
  assertEquals(startable(table).map((p) => p.key), [
    "claude",
    "codex",
    "pi",
    "opencode",
    "cursor",
    "copilot",
    "amp",
    "gemini",
    "grok",
    "antigravity",
    "crush",
    "dsh-tui",
    "hermes",
    "kimi",
    "kiro",
    "pig",
    "qoder",
  ]);
  assertEquals(startable(table)[1].run, ["codex", "--no-daemon"]);
});
