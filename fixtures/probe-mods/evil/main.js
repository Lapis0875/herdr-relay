import { View, div } from "gpui-kit";

// All targets are synthetic or permission probes. No user's files are accessed.
export default class Evil extends View {
  init(props, cx) {
    this.result = "pending";
    cx.spawn(async (cx) => {
      if (props.attack === "self-kill") Deno.kill(Deno.pid, "SIGKILL");
      if (props.attack === "exit") Deno.exit(7);
      if (props.attack === "hog") {
        Deno.stdout.writeSync(new TextEncoder().encode("HOG_STARTED\n"));
        while (true) { /* watchdog probe */ }
      }
      if (props.attack === "oom") {
        const chunks = [];
        while (true) chunks.push(new Array(100_000).fill(Math.random()));
      }
      if (props.attack === "flood") {
        for (let i = 0; i < 30; i++) {
          const conn = await Deno.connect({ hostname: "127.0.0.1", port: props.ctlPort });
          await conn.write(new TextEncoder().encode(JSON.stringify({ t: "hello", folder: "evil", pid: Deno.pid }) + "\n"));
          await conn.read(new Uint8Array(1));
          conn.close();
        }
        this.result = "allowed";
        cx.notify();
        return;
      }
      const attacks = {
        S01: () => Deno.readTextFile(props.secret),
        S02: async () => {
          for (const [vector, attempt] of [
            ["dynamic", () => import(`file://${props.secretModule}`)],
            ["static-parent", () => import("./static.js")],
            ["computed-relative", () => import("../../../" + "secret.js")],
            ["file-fetch", () => fetch(`file://${props.secretModule}`)],
          ]) {
            try {
              const value = await attempt();
              value?.body?.cancel?.();
              return `${vector}: succeeded`;
            } catch (error) {
              const name = error?.name;
              if (name !== "NotCapable" && name !== "PermissionDenied" &&
                  !(name === "TypeError" && /requires read access|file scheme|scheme.*not supported/i.test(String(error)))) return `${vector}: ${error}`;
            }
          }
          return "denied";
        },
        S05: async () => {
          for (const path of [props.settings, props.otherMod]) {
            try { await Deno.readTextFile(path); return "available"; }
            catch (error) {
              if (error?.name !== "NotCapable" && error?.name !== "PermissionDenied") return `unexpected: ${error}`;
            }
          }
          return "denied";
        },
        S07: async () => {
          const child = await import("node:child_process");
          for (const attempt of [
            () => new Deno.Command("/bin/sh", { args: ["-c", "exit 0"] }).output(),
            () => child.execFileSync("/bin/sh", ["-c", "exit 0"]),
          ]) {
            try { await attempt(); return "available"; }
            catch (error) {
              if (error?.name !== "NotCapable" && error?.name !== "PermissionDenied") return `unexpected: ${error}`;
            }
          }
          return "denied";
        },
        S17: () => Deno.connect({ hostname: "127.0.0.1", port: props.port }),
        S18: async () => {
          const conn = await Deno.connect({ hostname: "127.0.0.1", port: props.ctlPort });
          try {
            await conn.write(new TextEncoder().encode(JSON.stringify({ t: "hello", folder: "evil", pid: Deno.pid }) + "\n"));
            const timeout = Promise.withResolvers();
            const timer = setTimeout(() => timeout.resolve("timeout"), 1000);
            try {
              const result = await Promise.race([conn.read(new Uint8Array(32)), timeout.promise]);
              return result === null ? "denied" : "available";
            } finally { clearTimeout(timer); }
          } finally { conn.close(); }
        },
        S19: async () => {
          const runtime = await import(`file://${props.runtime}`);
          const rpc = runtime.post({ t: "rpc", id: 999001, copy: "safe:probe", method: "readTextFile", args: [props.secret] });
          const emit = runtime.post({ t: "emit", copy: "safe:probe", method: "run", args: ["layout.select", {}] });
          const tree = runtime.post({ t: "tree", copy: "safe:probe", n: 1, ms: 0, tree: { text: "forged" } });
          return rpc && emit && tree ? "denied" : "available";
        },
        S20: async () => {
          const process = (await import("node:process")).default;
          for (const attempt of [
            () => Deno.env.get("HOME"),
            () => process.env.HOME,
            () => Deno.hostname(),
            () => Deno.dlopen("/usr/lib/libSystem.B.dylib", {}),
            () => Deno.listen({ hostname: "127.0.0.1", port: 0 }),
          ]) {
            try {
              const value = await attempt();
              value?.close?.();
              return "available";
            } catch (error) {
              if (error?.name !== "NotCapable" && error?.name !== "PermissionDenied") return `unexpected: ${error}`;
            }
          }
          return "denied";
        },
        S21: async () => {
          for (const specifier of ["https://probe.invalid/a.js", "npm:probe-package-forbidden", "jsr:@probe/forbidden"]) {
            try {
              await import(specifier);
              return "available";
            } catch (error) {
              if (!/--no-remote|--no-npm|remote modules are not allowed|requires import access/i.test(String(error))) {
                return `unexpected: ${String(error)}`;
              }
            }
          }
          return "denied";
        },
        S23: () => typeof globalThis.caches === "undefined" && typeof globalThis.BroadcastChannel === "undefined" ? "denied" : "available",
        S22: async () => (await Deno.permissions.request({ name: "read", path: "/" })).state,
        S24: () => Deno[Deno.internal] === undefined ? "denied" : "available",
        S25: () => {
          const forged = { t: "emit", copy: "safe:probe", method: "run", args: ["layout.select", { child: "forged" }] };
          Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(forged) + "\n"));
          return "denied";
        },
        S26: () => Deno.kill(Deno.ppid, "SIGCONT"),
        S36: async () => {
          const timer = Promise.withResolvers();
          setTimeout(timer.resolve, 1000);
          await timer.promise;
          return await Deno.readTextFile(props.link);
        },
      };
      try {
        const result = await attacks[props.attack]();
        this.result = result === "denied" ? "blocked" : `allowed:${result}`;
      } catch (error) {
        this.result = error?.name === "NotCapable" || error?.name === "PermissionDenied" ? "blocked" : `error:${error?.name}`;
      }
      cx.notify();
    });
  }
  render() { return div().id("probe").child(this.result); }
}
