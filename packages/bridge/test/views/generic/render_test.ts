import { delay } from "@std/async";
import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { type JsonObject, type JsonValue, toElementTree } from "@herdr-relay/protocol";
import { HostSupervisor } from "../../../src/hosts/supervisor.ts";
import { layoutBlocks, paneHeaderFolders } from "../../../src/views/copies.ts";
import type { HerdrData } from "../../../src/views/data.ts";
import { ViewManager } from "../../../src/views/manager.ts";
import { fixtureState } from "../../fixtures/state.ts";
import { privateFixture } from "../../helpers/private_fixture.ts";

const overlays: Record<string, JsonObject> = {
  menu: { tab: "space", target: { id: "s1" } },
  "new-menu": {},
  picker: {},
  confirm: { title: "Confirm", message: "Continue?" },
  prompt: { title: "Prompt", message: "Name" },
  toast: { title: "Notice" },
  help: {},
  peek: {},
  worktree: { action: "open", space: "s1", folder: ".tmp/fixture-home/project" },
  "machine-add": {},
};

/** Measured render-time calls from OSS-PLAN §2.1. Any new shape requires review. */
function documentedCall(folder: string, method: string, args: JsonValue[]): boolean {
  if (method === "hc") {
    return ["spaces", "picker", "win98", "machine-add"].includes(folder) &&
      JSON.stringify(args[0]) === JSON.stringify(["machine", "ls", "--json"]);
  }
  if (method !== "exec" || typeof args[0] !== "string" || !Array.isArray(args[1])) return false;
  const [command, argv] = args as [string, JsonValue[]];
  const text = JSON.stringify(argv);
  if (command === "git") {
    const common = [["rev-parse", "--show-toplevel"]];
    const gitStatus = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status"];
    const changesPrefix = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
    const byFolder: Record<string, string[][]> = {
      files: [...common, [...gitStatus, "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]],
      changes: [
        ...common,
        [...changesPrefix, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
        [...changesPrefix, "rev-parse", "--verify", "HEAD"],
        [...changesPrefix, "diff", "HEAD", "--numstat", "-z", "--no-renames"],
      ],
      spaces: [
        ...common,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        ["symbolic-ref", "-q", "HEAD"],
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        [...gitStatus, "--porcelain=v2", "--branch"],
      ],
      menu: [...common, ["rev-parse", "--path-format=absolute", "--git-common-dir"]],
      worktree: [
        ...common,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["worktree", "list", "--porcelain"],
        ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"],
      ],
    };
    return (byFolder[folder] ?? []).some((shape) => JSON.stringify(shape) === text);
  }
  if (folder === "files" && command === "sh" && argv.length === 4 && argv[0] === "-c" && argv[2] === "files") {
    return argv[1] ===
        'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"' &&
      typeof argv[3] === "string";
  }
  if (folder === "win98" && command === "sh" && argv.length === 2 && argv[0] === "-c") {
    return argv[1] === 'ps -o etime= -p "$PPID"' ||
      (typeof argv[1] === "string" &&
        /^for c in [A-Za-z0-9_ -]+; do command -v "\$c" >\/dev\/null 2>&1 && echo "\$c"; done$/.test(argv[1]));
  }
  return false;
}

function containsError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsError);
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.k === "error" || Object.values(obj).some(containsError);
}

/** Normalise only the wall-clock display; all other rendered content remains unchanged. */
function normaliseClock(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normaliseClock(item);
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.id === "tray-clock") {
      const attrs = obj.attrs as Record<string, unknown> | undefined;
      if (attrs && typeof attrs.tooltip === "string") attrs.tooltip = "<date>";
      if (Array.isArray(obj.children)) {
        for (const child of obj.children) {
          if (child && typeof child === "object" && child.k === "text") child.text = "<time>";
        }
      }
    }
    for (const child of Object.values(obj)) normaliseClock(child);
  }
}

async function compareOrUpdateGolden(path: string, actual: unknown, update: boolean): Promise<void> {
  if (update) {
    await Deno.writeTextFile(path, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  let expected: unknown;
  try {
    expected = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing golden ${path}; run deno task test:views:update`);
    }
    throw error;
  }
  assertEquals(actual, expected, `Golden mismatch: ${path}`);
}

async function renderLayout(name: string, appHome = "fixtures/generic-home", privateRun = false) {
  await Deno.mkdir(".tmp", { recursive: true });
  const run = await Deno.makeTempDir({ dir: resolve(".tmp"), prefix: `views-${name}-` });
  const state = fixtureState(appHome, ".tmp/fixture-home", name, "fixtures/generic-home");
  const shapes: Record<string, string[]> = {};
  const errors: string[] = [];
  const trees = new Map<string, JsonValue>();
  const specs = layoutBlocks(state.layout);
  for (const folder of paneHeaderFolders(state.layout)) {
    const props: JsonObject = { pane: "p1", terminal: "t1" };
    if (folder === "win98") props.role = "window";
    specs.set(`${folder}:pane:p1`, { props, placement: null });
  }
  if (privateRun) {
    // The private cockpit requires its own hub protocol and data; no synthetic success is claimed.
    for (const copy of specs.keys()) if (copy.startsWith("lstack-herdr-cockpit:")) specs.delete(copy);
    console.log("private cockpit copies skipped: no faithful fixture hub is available");
  }
  if (name === "main" && !privateRun) {
    for (const [folder, props] of Object.entries(overlays)) {
      specs.set(`${folder}:overlay:fixture`, { props: { ...props, overlay: "fixture" }, placement: null });
    }
  }
  if (name === "win98" && !privateRun) {
    for (const role of ["menu", "dialog", "mines", "sol"]) {
      const props = { role, overlay: `fixture-${role}`, ...(role === "dialog" ? { kind: "network" } : {}) };
      specs.set(`win98:overlay:fixture-${role}`, { props, placement: null });
    }
  }
  const data: HerdrData = {
    layout: () => ({ layout: { name, tree: state.layout }, clicks: null }),
    world: () => ({ spaces: state.spaces, panes: state.panes, agents: state.agents, focused: state.focused }),
    commands: () => state.commands,
    hostState: (folder) => ({ ...state, folder }),
    look: () => ({
      theme: state.theme,
      settings: state.settings,
      fonts: { ui: "sans-serif", mono: "monospace", terminal: "monospace" },
    }),
    snapshot: () => ({
      spaces: state.spaces,
      panes: state.panes,
      agents: state.agents,
      terminals: state.terminals,
      focused: state.focused,
      shared: state.shared,
    }),
    subscribe: () => () => {},
    emit: () => {},
    sessionClosed: () => {},
    passthrough: () => Promise.reject(new Error("unexpected passthrough")),
    rpc: (host, msg) => {
      if (msg.method === "exec" || msg.method === "hc") {
        (shapes[host.folder] ??= []).push(
          JSON.stringify([msg.method, ...msg.args]).replaceAll(
            resolve(".tmp/fixture-home/project"),
            ".tmp/fixture-home/project",
          ),
        );
        if (!privateRun && !documentedCall(host.folder, msg.method, msg.args)) {
          errors.push(`${host.folder}: undocumented ${msg.method} shape ${JSON.stringify(msg.args)}`);
        }
        if (msg.method === "hc") {
          return Promise.resolve({ code: 0, stdout: '{"machines":[]}', stderr: "" });
        }
        const command = msg.args[0];
        const argv = msg.args[1];
        if (command === "git" && Array.isArray(argv) && argv.includes("--show-toplevel")) {
          return Promise.resolve({ code: 0, stdout: `${resolve(".tmp/fixture-home/project")}\n`, stderr: "" });
        }
        if (command === "git" && Array.isArray(argv) && argv.includes("--git-common-dir")) {
          return Promise.resolve({ code: 0, stdout: `${resolve(".tmp/fixture-home/project/.git")}\n`, stderr: "" });
        }
        if (command === "git" && Array.isArray(argv) && argv[0] === "symbolic-ref") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        }
        if (command === "git" && Array.isArray(argv) && argv[0] === "rev-list") {
          return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no upstream configured\n" });
        }
        if (command === "git" || (host.folder === "files" && command === "sh")) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 1, stdout: "", stderr: "fixture: command refused" });
      }
      if (msg.method === "watchFolder") return Promise.reject(new Error("fixture has no folder watcher"));
      if (msg.method === "knownAgents") return Promise.resolve([]);
      if (msg.method === "readTextFile") return Promise.reject(new Error("fixture file unavailable"));
      return Promise.reject(new Error(`fixture: unsupported RPC ${msg.method}`));
    },
  };
  let supervisor!: HostSupervisor;
  const manager = await ViewManager.start({
    data,
    roots: [],
    hosts: async (wiring) => {
      const handlers = wiring.handlers;
      supervisor = await HostSupervisor.create({
        appHome,
        modhost: "packages/modhost",
        run,
        stateDir: run,
        stateFor: wiring.stateFor,
        handlers: {
          ...handlers,
          tree: (host, message) => {
            const converted = toElementTree(message.tree);
            if (converted.diagnostics.length) errors.push(`${message.copy}: ${JSON.stringify(converted.diagnostics)}`);
            if (containsError(converted.tree)) errors.push(`${message.copy}: rendered an error node`);
            trees.set(message.copy, converted.tree as unknown as JsonValue);
            handlers.tree?.(host, message);
          },
          error: (host, message) => {
            errors.push(`${host.folder}: ${message.where}: ${message.error}`);
            handlers.error?.(host, message);
          },
        },
      });
      return supervisor;
    },
  });
  try {
    for (const [copy, spec] of specs) supervisor.create(copy, spec.props, spec.placement);
    const deadline = Date.now() + 30_000;
    while (trees.size < specs.size && Date.now() < deadline) await delay(50);
    // Allow initial async RPCs and their subsequent renders to finish before recording coverage.
    await delay(750);
    assertEquals([...specs.keys()].filter((copy) => !trees.has(copy)), [], "copies without a rendered tree");
    assertEquals(errors, [], "modhost or conversion diagnostics");
    assert(trees.size > 0, "layout must render at least one mod");
    const dir = privateRun ? `fixtures/private/trees/${name}` : `fixtures/trees/generic/${name}`;
    const env = await Deno.permissions.query({ name: "env", variable: "HERDR_RELAY_UPDATE_TREES" });
    const update = env.state === "granted" && Deno.env.get("HERDR_RELAY_UPDATE_TREES") === "1";
    if (update) await Deno.mkdir(dir, { recursive: true });
    for (const [copy, tree] of trees) {
      if (copy === "win98:taskbar") normaliseClock(tree);
      await compareOrUpdateGolden(`${dir}/${encodeURIComponent(copy)}.json`, tree, update);
    }
    const orderedShapes = Object.fromEntries(
      Object.entries(shapes).sort(([a], [b]) => a.localeCompare(b)).map(([folder, calls]) => [
        folder,
        [...new Set(calls)].sort(),
      ]),
    );
    await compareOrUpdateGolden(`${dir}/calls.json`, orderedShapes, update);
    console.log(`${privateRun ? "private" : "generic"}/${name}: ${trees.size} trees`);
  } finally {
    manager.stop();
    await supervisor.stop();
    await Deno.remove(run, { recursive: true });
  }
}

Deno.test("render-time shape comparison rejects unknown commands and wrong folders", () => {
  assert(documentedCall("spaces", "hc", [["machine", "ls", "--json"], {}]));
  assert(!documentedCall("tabs", "hc", [["machine", "ls", "--json"], {}]));
  assert(!documentedCall("spaces", "hc", [["machine", "rm", "fixture", "--json"], {}]));
  assert(documentedCall("worktree", "exec", ["git", ["worktree", "list", "--porcelain"], {}]));
  assert(!documentedCall("files", "exec", ["git", ["worktree", "list", "--porcelain"], {}]));
  assert(!documentedCall("worktree", "exec", ["git", ["worktree", "add", "unexpected"], {}]));
});

for (const name of ["main", "terminals", "win98"]) {
  Deno.test({
    name: `Seatbelt renders generic ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => renderLayout(name),
  });
}

privateFixture("Seatbelt renders private lstack layout", (home) => renderLayout("lstack-herdr", home, true));

// Git writes, machine changes, URL opening and remote worktree forms need interaction.
// Their allow/refusal variants are covered by the T49 policy tests, not these initial renders.
