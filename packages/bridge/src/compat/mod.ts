/** Version and drift detection (OSS-PLAN §2.3, T46): contract pins, the start-time check, `hello.compat`, doctor. */

export {
  type CommandsCapture,
  type CompatObservation,
  type CompatReport,
  compatReport,
  compatSummary,
  helloCompat,
  type InstalledHashes,
  observeCompat,
  parseCommandsCapture,
} from "./check.ts";
export { compatDoctorLines } from "./doctor.ts";
export {
  compareVersions,
  CONTRACT_PINS,
  type ContractPins,
  SUPPORTED_FROM,
  testedVersions,
  type VersionPins,
} from "./pins.ts";
