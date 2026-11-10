/**
 * The three user decisions DESIGN-v2 §8 left open (U1–U3), confirmed by the user on 2026-11-09. This is the only
 * place their values live; the exec policy reads them through `PolicyContext.decisions` (defaulting to these), so
 * tests can flip one per call.
 */

export interface UserDecisions {
  /** U1: `changes` commits from a device (`git add -A`, `git commit -m <msg>`, rule E5) for `act`-scope devices. */
  readonly gitCommitFromActDevices: boolean;
  /** U2: regenerating the lstack fork from a device (`node …/lstack-herdr/sync.mjs`, rule E2) for `act` scope. */
  readonly syncFromDevices: boolean;
  /** U3: `open <http(s) url>` (rule E11) opens on the device that triggered it (toast action), never on the Mac. */
  readonly openUrlOnDevice: boolean;
}

export const USER_DECISIONS: UserDecisions = Object.freeze({
  /** U1 = allow for `act` scope only (confirmed). */
  gitCommitFromActDevices: true,
  /** U2 = refuse; toast "Run Sync on the Mac" (confirmed). */
  syncFromDevices: false,
  /** U3 = open on the triggering device (confirmed). */
  openUrlOnDevice: true,
});
