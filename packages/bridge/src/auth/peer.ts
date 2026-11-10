/**
 * Who opened a connection to the bridge (Shepherdr `peer.ts`). `Tailscale-User-Login` is believed only on a connection
 * opened by tailscaled — root (Linux, the standalone macOS build's system extension) or this user (the App Store
 * build's `IPNExtension`) — because another account on the computer could reach 127.0.0.1 and send the header itself.
 * Only the exact connection counts: caller `127.0.0.1:<port>` → `127.0.0.1:<service>`, ESTABLISHED; none or several
 * owners mean "not believed". The platform picks the strategy (`../platform.ts`, G11).
 *
 * `netstat-lsof` (macOS). Two sources, because macOS 27 hides the TCP socket table (`netstat`'s sysctl) from processes
 * started under a non-platform binary such as deno — measured: `netstat -anv -p tcp` prints nothing when run from deno,
 * node or Xcode's python, and the full table from a shell, perl or ruby:
 * 1. `netstat -anv -p tcp` names the process of every socket (`name:pid`, any user); `ps` says whose it is, and the
 *    process must still hold the socket after `ps` answered (pid reuse).
 * 2. When netstat does not list the connection, `lsof -F pun` (libproc), which works from deno but sees only this
 *    user's processes: it can confirm this user's `IPNExtension`, never root's tailscaled or another account.
 * Needs `/usr/sbin/netstat`, `/bin/ps` and `/usr/sbin/lsof` in the bridge's `--allow-run`; a refused spawn fails closed.
 *
 * `proc-net-tcp` (Linux). `/proc/net/tcp` and `/proc/net/tcp6` list every socket of the network namespace with its
 * owner's uid; nothing is spawned. This user is the owner of the bridge's own listening socket in the same snapshot.
 * Needs both files in the bridge's `--allow-read`; `/proc/net/tcp` unreadable fails closed, `/proc/net/tcp6` unreadable
 * (IPv6 off) counts as empty.
 */

import { hostPlatform, type PeerStrategy } from "../platform.ts";

export const NETSTAT = "/usr/sbin/netstat";
export const PS = "/bin/ps";
export const LSOF = "/usr/sbin/lsof";
export const PROC_NET_TCP = ["/proc/net/tcp", "/proc/net/tcp6"] as const;

/** Runs a program; stdout on success, `null` on any failure. Injectable for tests. */
export type CommandRun = (cmd: string, args: string[]) => Promise<string | null>;

/** Reads a text file; `null` on any failure. Injectable for tests. */
export type TextRead = (path: string) => Promise<string | null>;

export const runCommand: CommandRun = async (cmd, args) => {
  try {
    const r = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch {
    return null;
  }
};

export const readText: TextRead = async (path) => {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
};

/**
 * Pids holding the caller's side `127.0.0.1.<port>` → `127.0.0.1.<service>`, ESTABLISHED, from `netstat -anv -p tcp`.
 * The pid is the last `<name>:<pid>` token followed only by netstat's own hex columns (a process name may contain
 * spaces and colons, never after that token).
 */
export function darwinPids(netstat: string, port: number, service: number): number[] {
  const pids: number[] = [];
  for (const line of netstat.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[3] !== `127.0.0.1.${port}` || f[4] !== `127.0.0.1.${service}` || f[5] !== "ESTABLISHED") continue;
    const at = f.map((x) => /:\d+$/.test(x)).lastIndexOf(true);
    if (at < 6 || f.length - at < 3 || !f.slice(at + 1).every((x) => /^[0-9a-f]+$/i.test(x))) continue;
    pids.push(Number(f[at].split(":").pop()));
  }
  return pids;
}

/** Uids (by pid) holding the caller's side `127.0.0.1:<port>->127.0.0.1:<service>` in `lsof -F pun` output. */
export function lsofOwners(lsof: string, port: number, service: number): Map<number, number> {
  const owners = new Map<number, number>();
  const want = `n127.0.0.1:${port}->127.0.0.1:${service}`;
  let pid: number | null = null;
  let uid: number | null = null;
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) {
      pid = /^p\d+$/.test(line) ? Number(line.slice(1)) : null;
      uid = null;
    } else if (line.startsWith("u")) uid = /^u\d+$/.test(line) ? Number(line.slice(1)) : null;
    else if (line === want && pid !== null && uid !== null) owners.set(pid, uid);
  }
  return owners;
}

/** One row of `/proc/net/tcp` or `/proc/net/tcp6`: addresses as the kernel prints them (hex), ports as numbers. */
export interface ProcSocket {
  local: string;
  localPort: number;
  remote: string;
  remotePort: number;
  /** Kernel TCP state, two hex digits (`01` ESTABLISHED, `0A` LISTEN). */
  state: string;
  uid: number;
}

/** 127.0.0.1 as `/proc/net/tcp` prints it (one host-order word) and `::ffff:127.0.0.1` as `/proc/net/tcp6` does. */
const PROC_LOOPBACK: ReadonlySet<string> = new Set(["0100007F", "0000000000000000FFFF00000100007F"]);
const PROC_ESTABLISHED = "01";
const PROC_LISTEN = "0A";

/** The socket rows of a `/proc/net/tcp{,6}` table (header and malformed lines skipped). */
export function procSockets(table: string): ProcSocket[] {
  const out: ProcSocket[] = [];
  const endpoint = (s: string | undefined) => /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(s ?? "");
  for (const line of table.split("\n")) {
    const f = line.trim().split(/\s+/);
    const local = endpoint(f[1]);
    const remote = endpoint(f[2]);
    if (!/^\d+:$/.test(f[0]) || !local || !remote || !/^[0-9A-F]{2}$/i.test(f[3] ?? "") || !/^\d+$/.test(f[7] ?? "")) {
      continue;
    }
    out.push({
      local: local[1].toUpperCase(),
      localPort: parseInt(local[2], 16),
      remote: remote[1].toUpperCase(),
      remotePort: parseInt(remote[2], 16),
      state: f[3].toUpperCase(),
      uid: Number(f[7]),
    });
  }
  return out;
}

/**
 * From one snapshot of the tables: the uids holding the caller's side `127.0.0.1:<port>` → `127.0.0.1:<service>`,
 * ESTABLISHED, and the uids holding the bridge's listening socket `127.0.0.1:<service>` (this user).
 */
export function procOwners(sockets: readonly ProcSocket[], port: number, service: number) {
  const caller = sockets.filter((s) =>
    s.state === PROC_ESTABLISHED && PROC_LOOPBACK.has(s.local) && s.localPort === port &&
    PROC_LOOPBACK.has(s.remote) && s.remotePort === service
  );
  const listener = sockets.filter((s) =>
    s.state === PROC_LISTEN && PROC_LOOPBACK.has(s.local) && s.localPort === service
  );
  return { caller: caller.map((s) => s.uid), listener: listener.map((s) => s.uid) };
}

/** The one uid among `uids`, or `null` when there is none or there are several. */
function onlyUid(uids: Iterable<number>): number | null {
  const set = new Set(uids);
  return set.size === 1 ? [...set][0] : null;
}

export class PeerCheck {
  readonly #service: number;
  readonly #run: CommandRun;
  readonly #strategy: PeerStrategy;
  readonly #read: TextRead;
  #self: Promise<number | null> | null = null;

  /** `service`: the bridge's own listening port; `strategy`: the platform's (`netstat-lsof` on macOS). */
  constructor(
    service: number,
    run: CommandRun = runCommand,
    strategy: PeerStrategy = hostPlatform().peerCheck,
    read: TextRead = readText,
  ) {
    this.#service = service;
    this.#run = run;
    this.#strategy = strategy;
    this.#read = read;
  }

  /** The uid owning the caller's side of the connection from `remotePort`, or `null`. */
  async uidOf(remotePort: number): Promise<number | null> {
    if (this.#strategy === "proc-net-tcp") return (await this.#procOwners(remotePort))?.caller ?? null;
    const pids = await this.#netstatPids(remotePort);
    if (pids === null || pids.length === 0) return await this.#lsofUid(remotePort);
    const uids = new Set<number>();
    for (const pid of pids) {
      const uid = await this.#psUid(pid);
      if (uid === null) return null;
      uids.add(uid);
    }
    if (JSON.stringify(await this.#netstatPids(remotePort)) !== JSON.stringify(pids)) return null;
    return onlyUid(uids);
  }

  /** tailscaled (root) or this computer's user (the macOS App Store build's network extension). */
  async trusted(remotePort: number): Promise<boolean> {
    if (this.#strategy === "proc-net-tcp") {
      const owners = await this.#procOwners(remotePort);
      if (owners === null || owners.caller === null) return false;
      return owners.caller === 0 || owners.caller === owners.self;
    }
    const uid = await this.uidOf(remotePort);
    if (uid === null) return false;
    if (uid === 0) return true;
    const self = await (this.#self ??= this.#psUid(Deno.pid));
    if (self === null) this.#self = null;
    return uid === self;
  }

  async #netstatPids(remotePort: number): Promise<number[] | null> {
    const out = await this.#run(NETSTAT, ["-anv", "-p", "tcp"]);
    return out === null ? null : darwinPids(out, remotePort, this.#service);
  }

  async #psUid(pid: number): Promise<number | null> {
    const out = (await this.#run(PS, ["-o", "uid=", "-p", String(pid)]))?.trim() ?? "";
    return /^\d+$/.test(out) ? Number(out) : null;
  }

  async #lsofUid(remotePort: number): Promise<number | null> {
    const out = await this.#run(LSOF, ["-nP", `-iTCP@127.0.0.1:${remotePort}`, "-sTCP:ESTABLISHED", "-F", "pun"]);
    return onlyUid(lsofOwners(out ?? "", remotePort, this.#service).values());
  }

  /** The caller's and the bridge's uids from one read of the tables; `null` when `/proc/net/tcp` is unreadable. */
  async #procOwners(remotePort: number): Promise<{ caller: number | null; self: number | null } | null> {
    const [v4, v6] = await Promise.all(PROC_NET_TCP.map((path) => this.#read(path)));
    if (v4 === null) return null;
    const owners = procOwners([...procSockets(v4), ...procSockets(v6 ?? "")], remotePort, this.#service);
    return { caller: onlyUid(owners.caller), self: onlyUid(owners.listener) };
  }
}
