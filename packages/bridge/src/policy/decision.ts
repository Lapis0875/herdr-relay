/**
 * Policy outcomes shared by the read, exec and symlink policies: the refusal error, the exec result shape mods
 * receive, and the decision log (`<state>/log/policy.ndjson`, DESIGN-v2 §2: every decision `{folder, method, argv,
 * decision}` plus the folder's policy profile, ring of 10 MiB). Rule ids are the protocol's `PolicyRule` so tests and
 * docs share them.
 */

import { join } from "@std/path";
import type { PolicyDecision, PolicyLogRecord, PolicyRule } from "@herdr-relay/protocol";

/** A request the policy refuses. `message` is safe to show on a device (no absolute paths beyond the mod's own). */
export class PolicyRefusal extends Error {
  readonly rule: PolicyRule;
  constructor(rule: PolicyRule, reason: string) {
    super(reason);
    this.name = "PolicyRefusal";
    this.rule = rule;
  }
}

/** Throws a `PolicyRefusal`. */
export function refuse(rule: PolicyRule, reason: string): never {
  throw new PolicyRefusal(rule, reason);
}

/** What `herdr.exec`/`herdr.hc` resolve with (`gpui-kit.d.ts` `ExecResult`). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exit code of a refused exec: "command cannot execute". Mods already handle non-zero codes. */
export const REFUSED_EXIT_CODE = 126;

/** The result a refused exec resolves with (DESIGN-v2 §2.3). */
export function refusedResult(reason: string): ExecResult {
  return { code: REFUSED_EXIT_CODE, stdout: "", stderr: `herdr-relay: ${reason}` };
}

/** Receives every decision. The bridge passes `fileLog(<state>)`; tests pass a collecting function. */
export type PolicyLog = (record: PolicyLogRecord) => void;

/** A decision as the policy reports it; `ts` is added by `logDecision`. */
export interface DecisionInput {
  folder: string | null;
  method: string;
  argv: readonly string[];
  decision: PolicyDecision;
  rule: PolicyRule;
  reason?: string;
  session?: string;
  /** The policy profile applied to `folder` (OSS-PLAN §1). */
  profile?: string;
}

/** Longest argv element kept in the log (JSON arguments and commit messages can be long). */
const LOG_ARG_MAX = 2048;

export function logDecision(log: PolicyLog, d: DecisionInput): void {
  const record: PolicyLogRecord = {
    ts: Date.now(),
    folder: d.folder,
    method: d.method,
    argv: d.argv.map((a) => (a.length > LOG_ARG_MAX ? `${a.slice(0, LOG_ARG_MAX)}…` : a)),
    decision: d.decision,
    rule: d.rule,
  };
  if (d.reason !== undefined) record.reason = d.reason;
  if (d.session !== undefined && d.session !== "") record.session = d.session;
  if (d.profile !== undefined) record.profile = d.profile;
  log(record);
}

/** Size at which `policy.ndjson` is rotated to `policy.ndjson.1` (the previous `.1` is replaced). */
export const POLICY_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The bridge's decision log: one JSON object per line in `<state>/log/policy.ndjson` (directory 0700, file 0600).
 * Writes are synchronous so records stay in decision order; a failing write is reported once on stderr and the
 * decision itself is unaffected.
 */
export function fileLog(stateDir: string, maxBytes = POLICY_LOG_MAX_BYTES): PolicyLog {
  const dir = join(stateDir, "log");
  const path = join(dir, "policy.ndjson");
  const enc = new TextEncoder();
  let file: Deno.FsFile | null = null;
  let size = 0;
  let failed = false;
  const open = () => {
    Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = Deno.openSync(path, { append: true, create: true, mode: 0o600 });
    size = file.statSync().size;
  };
  return (record) => {
    try {
      const bytes = enc.encode(JSON.stringify(record) + "\n");
      if (file === null) open();
      if (size > 0 && size + bytes.length > maxBytes) {
        file!.close();
        Deno.renameSync(path, `${path}.1`);
        open();
      }
      let off = 0;
      while (off < bytes.length) off += file!.writeSync(bytes.subarray(off));
      size += bytes.length;
    } catch (e) {
      if (!failed) console.error(`herdr-relay: policy log ${path}: ${e instanceof Error ? e.message : e}`);
      failed = true;
      file = null;
    }
  };
}
