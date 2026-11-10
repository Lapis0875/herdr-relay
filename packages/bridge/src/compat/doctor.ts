/**
 * `herdr-relay doctor`'s Herdr compatibility section (T44 calls it): the bridge's start-time check, run once on its
 * own — `herdr-app --version`, `herdr-app commands` (both read-only) and the app home's contract surfaces — as the
 * lines `compatSummary` (`./check.ts`) prints. Needs read access to the app home and `--allow-run=herdr-app`.
 */

import { type HerdrAppEnv, HerdrVersion } from "../herdr/version.ts";

/** The compat lines for the app home in `o` (`appHome` as the bridge resolves it: `HERDR_APP_HOME` or the default). */
export async function compatDoctorLines(o: HerdrAppEnv): Promise<string[]> {
  const version = new HerdrVersion({ ...o, log: () => {} });
  await version.start();
  return version.summary();
}
