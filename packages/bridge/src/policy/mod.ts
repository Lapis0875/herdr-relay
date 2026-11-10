/**
 * Bridge-side policy (DESIGN-v2 §2): read roots and realpath checks, the load-time symlink audit, the exec allowlist
 * E1–E16 with its scoped runners, the policy profiles that decide which rows and roots each mod folder gets
 * (OSS-PLAN §1), and the decision log. `run()` command classes live in `commands.json` (session code).
 */

export * from "./decision.ts";
export * from "./exec.ts";
export * from "./exec.table.ts";
export * from "./listing.ts";
export * from "./paths.ts";
export * from "./read.ts";
export * from "./profiles.ts";
export * from "./scripts.ts";
export * from "./spawn.ts";
export * from "./symlink.ts";
export * from "./user-decisions.ts";
