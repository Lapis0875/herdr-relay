/**
 * Policy decision records (`<state>/log/policy.ndjson`, one JSON object per line), so the bridge policy, SECURITY tests
 * and docs share rule ids. Rule ids follow docs/POLICY.md: `E1`–`E16` are the exec allowlist rows (§2.3); the others
 * name the section whose rule decided.
 */

import { PROFILE_ID_PATTERN } from "./profile.ts";
import { array, define, enumOf, integer, nullable, object, type Static, string } from "./schema.ts";

/** Exec allowlist rows, POLICY.md §2.3. */
export const EXEC_RULES = [
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "E7",
  "E8",
  "E9",
  "E10",
  "E11",
  "E12",
  "E13",
  "E14",
  "E15",
  "E16",
] as const;

/**
 * Every rule id:
 * - `E1`–`E16`: exec/hc rows (§2.3);
 * - `read`: read roots, realpath, 1 MiB cap (§2.1, also the static route);
 * - `symlink`: load-time symlink audit (§2.2);
 * - `run.session` / `run.mod` / `run.structural` / `run.passthrough` / `run.unknown`: `run()` command classes (§2.4);
 * - `write`: `writeTextFile` and other writes (§2.6);
 * - `storage`: `storage.set` (§2.6);
 * - `net`: `net.*` to the cockpit hub port only;
 * - `rpc.unknown`: an RPC method outside the control protocol;
 * - `push`: a push subscription to an endpoint outside the three Web Push services (DESIGN-v2 §1.2);
 * - `origin`: a host call's origin token the bridge did not give that folder's current host within its lifetime
 *   (unknown, expired, another folder's or an earlier host generation's): downgraded to `read` from no device (S19).
 */
export const POLICY_RULES = [
  ...EXEC_RULES,
  "read",
  "symlink",
  "run.session",
  "run.mod",
  "run.structural",
  "run.passthrough",
  "run.unknown",
  "write",
  "storage",
  "net",
  "rpc.unknown",
  "push",
  "origin",
] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

/**
 * `intercept`: handled by the bridge instead of executed (E11 `open <url>` and the cockpit hub's `open_url` → device
 * toast; `run.session`).
 */
export const POLICY_DECISIONS = ["allow", "refuse", "intercept"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/**
 * One decision. `folder` is null for decisions not made for a mod folder (e.g. a device's push subscription);
 * `profile` is the policy profile applied to the folder (OSS-PLAN §1; absent without a folder).
 */
export const PolicyLogRecordSchema = define("PolicyLogRecord", () =>
  object({
    ts: integer({ minimum: 0, description: "ms since the epoch" }),
    folder: nullable(string({ minLength: 1 })),
    method: string({ minLength: 1 }),
    argv: array(string()),
    decision: enumOf(POLICY_DECISIONS),
    rule: enumOf(POLICY_RULES),
  }, {
    reason: string(),
    session: string({ minLength: 1 }),
    profile: string({ pattern: PROFILE_ID_PATTERN }),
  }));
export type PolicyLogRecord = Static<typeof PolicyLogRecordSchema>;
