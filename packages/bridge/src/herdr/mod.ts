/**
 * The `herdr` implementation (DESIGN-v2 §4 T09): {@link HerdrSource} is the view manager's `HerdrData` on this Mac's
 * herdr-core, appHome files and (when installed) the mirror mod's snapshot.
 */

export { type AppFiles, CONFIG_MAX_BYTES, FILES_DEBOUNCE_MS, loadAppFiles, readJson, relevantPath } from "./files.ts";
export {
  clientFonts,
  effectiveSettings,
  isLight,
  parseThemeFile,
  resolveTheme,
  themeColors,
  type ThemeFile,
} from "./look.ts";
export {
  buildModel,
  type MacView,
  type Model,
  type ModelInput,
  type ProgramEntry,
  programOf,
  type ProgramTable,
  programTable,
  spaceFolders,
  startable,
} from "./model.ts";
export { HubProxy, type HubProxyOptions, MAX_NET_PER_FOLDER, NET_READ_MAX_BYTES } from "./net.ts";
export { folderName, REPO_TTL_MS, RepoCache, type RepoInfo } from "./repos.ts";
export {
  DOC_TIMEOUT_MS,
  type HerdrCore,
  HerdrSource,
  type HerdrSourceOptions,
  KNOWN_AGENTS_TTL_MS,
  type MirrorSnapshot,
  notSupportedRemotely,
  SHARED_OVERLAY_MAX_KEYS,
  SHARED_VALUE_MAX_BYTES,
  STATE_THROTTLE_MS,
} from "./source.ts";
export { FolderWatches, MAX_PENDING_PATHS, MAX_WATCHES_PER_FOLDER, WATCH_DEBOUNCE_MS, WATCH_IDLE_MS } from "./watch.ts";
