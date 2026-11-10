/**
 * The cockpit hub's requests as the bridge decides them on a `net.writes: "cockpit-hub"` connection (`./hub.ts`,
 * `../herdr/net.ts`). Taken from the cockpit mod's own client, the lstack fork kept unmodified in
 * `fixtures/private/herdr-home/mods/lstack-herdr-cockpit/` (paths below are relative to it); the hub itself (the
 * `cockpit` binary) is not in this repository, so a request whose effect the client code does not show is never
 * listed as a read.
 *
 * Framing: one JSON object per line, `\n`-terminated, `{op, token, frontend?, ...fields}` (`hub.js:129,178`); the hub
 * answers line by line (`hub.js:72-95`). `request()` opens one connection per request, writes one line, reads one
 * answer line and closes (`hub.js:120-138`); `subscribe()` writes one line and then only reads (`hub.js:169-206`).
 * `hub.js:122-126` opens `open_url` itself (through E11) and never sends it; a client that does send it is answered
 * by the bridge ({@link HUB_OPEN_URL_ACTION}).
 *
 * Classes:
 * - read ({@link HUB_READ_OPS}, `fetch` of a {@link HUB_FETCH_READS} kind): answers or follows hub state. Allowed for
 *   every origin, also none — a copy's subscription loop runs from `init`, outside any device event
 *   (`hub.js:169-178`).
 * - act (`act`, `fetch` of any other kind): changes hub or app state on the Mac. Needs a connected device with `act`
 *   scope (D3); a `read` device, a downgraded origin and no origin are refused.
 * - Herdr window ({@link HUB_HERDR_WINDOW_OPS}, {@link HUB_HERDR_WINDOW_ACTS}, an app's action outside
 *   {@link HUB_ACT_ONLY}): changes only the Herdr window on the Mac makes — new tabs or panes (forks, agents started,
 *   run or resumed), the Mac's focus, a page opened on the Mac. Refused for every origin (D3, U3); the
 *   device that asked gets the toast "<what> needs the Herdr window".
 * - Anything else (an op not listed here, a line that is not such an object) is refused.
 *
 * As in `./exec.table.ts`, tables looked up by a mod's strings are `Set`s or read with `Object.hasOwn`.
 */

/** Ops that only answer or follow hub state. */
export const HUB_READ_OPS: ReadonlySet<string> = new Set([
  // `subscribe(cx, {views, docs, notify}, …)`: views, store documents and notifications, live (hub.js:169-206).
  "subscribe",
  // `view(name, args)`: a view model once (hub.js:144), e.g. mail.js:62, review.js:108, palette.js:402, show.js:203.
  "view",
  // `search(query)`: the palette's search across apps (hub.js:147, palette.js:239).
  "search",
  // `events(app, since)`: what changed since `since` (hub.js:156; home.js:105, monitor.js:368, routines.js:153).
  "events",
  // `history(kind, key)`: a sparkline's series (hub.js:159).
  "history",
]);

/** The op whose `kind` decides between read and act. */
export const HUB_FETCH_OP = "fetch";

/**
 * `fetch(kind, args)` kinds that are reads: "Details on demand" (hub.js:152-153), fetched while a row is hovered or
 * shown, so they cannot change anything. Another kind is decided as an act.
 */
export const HUB_FETCH_READS: ReadonlySet<string> = new Set([
  // hub.js:152.
  "ci_log", // inbox.js:1164 (a failing PR's card)
  "failed_tests", // inbox.js:1163
  "review_threads", // inbox.js:1118
  "pr_files", // hub.js:152
  // inbox.js:450,839 (on hover),1115: the merge dialog's choices; the merge itself is the act `merge` (inbox.js:459).
  "pr_merge",
  // inbox.js:1178: a ticket's card; changing it is the act `set_state`/`assign` (inbox.js:542,1187).
  "ticket_card",
  // inbox.js:475: the plan the start dialog shows; starting is the act `start` (inbox.js:369,748).
  "start_plan",
]);

/** The op of an app's action: `{op: "act", app, action, args, armed?}` (hub.js:141; inbox.js:321, runbook.js:313). */
export const HUB_ACT_OP = "act";

/**
 * Ops refused for every origin, with what the toast names. `go(target)` "Brings a found item into view, in its app"
 * (hub.js:149-150): the hub sends `{focus, target}` to every subscriber (hub.js:163) — the Herdr window's own cockpit
 * copies on the Mac included — which then jump to the item (inbox.js:134, runbook.js:99, monitor.js:311, todo.js:60).
 * A device's focus stays on that device (D3); it moves within its own session instead (session commands).
 */
export const HUB_HERDR_WINDOW_OPS: Readonly<Record<string, string>> = {
  go: "Showing an item in the Herdr window", // palette.js:354, home.js:21, runbook.js:1280,1309
};

/**
 * `act` actions refused for every origin, by app, with what the toast names. Starting, running or resuming an agent is
 * structural: the hub spawns its terminal in Herdr. Installed cockpit CLI help (Main, 2026-11-10): `cockpit agent argv
 * <start|run|resume|fork>` builds those agent launches, and "cockpit act routine <slug>: the routine's last agent run
 * resumed in the actions space".
 */
export const HUB_HERDR_WINDOW_ACTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  agents: {
    // A new Herdr tab (`place: "tab"`) or pane (`"right"`, a split): agentsui.js:300-301,320 (the right-click menu),
    // pane.js:44,67 ("Fork this session to a new tab"), home.js:330 (fleet.js:127), recap.js:165, palette.js:390.
    fork: "Forking an agent",
    // Moves the Mac's focus to the agent (agentsui.js:220 lists `focus` among the agents actions).
    focus: "Going to an agent",
  },
  home: {
    // Agents a restart stopped, resumed (`agent argv resume`): home.js:799,805, status.js:108,185.
    resume: "Resuming agents",
  },
  inbox: {
    // "Fix with <agent>": an agent started on the failing PR (home.js:1015).
    fix_ci: "Fixing CI with an agent",
    // The start dialog's action, after `fetch start_plan` (inbox.js:369,475,757): an agent started on the item.
    start: "Starting work with an agent",
    // A cleanup toast's "Remove worktree" (inbox.js:346): as `git worktree remove`, a change only the Herdr window
    // makes (exec policy named refusal).
    remove_worktree: "Removing a worktree",
  },
  palette: {
    // ctrl-f: the found item into a fork of the agent below (palette.js:385,434): a new Herdr tab.
    fork: "Forking into a new tab",
  },
  runbook: {
    // A step's "session" action brings its handoff session forward on the Mac (runbook.js:343).
    focus_session: "Going to a runbook's session",
    // The PR opened by the hub, a background process on the Mac (hub.js:121; runbook.js:347,811); U3 opens links only
    // on the device, and the client gives no URL to hand it.
    open_pr: "Opening a PR from a runbook",
    // "Its session checks the preconditions first" (runbook.js:338-340): an agent session runs the step.
    run_step: "Running a runbook step",
    // A session to talk the runbook over (runbook.js:360-361).
    talk: "Talking a runbook over with an agent",
  },
  routines: {
    // "Edit the file" (routines.js:121,951): the hub opens the routine file on the Mac (U3: nothing opens on the Mac).
    edit: "Editing a routine's file",
    // A run's worktree "Open" (routines.js:978): opened on the Mac.
    open_worktree: "Opening a routine's worktree",
    // A run's worktree "Remove" (routines.js:293,979): as `git worktree remove` (exec policy named refusal).
    cleanup: "Removing a routine's worktree",
  },
};

/**
 * Apps whose `act` actions are refused for every origin unless listed here, with what the toast names: the rest come
 * from the hub's own model (`a.action`, routines.js:279,531,1109), so they cannot be listed by name, and running a
 * routine resumes its last agent run (`cockpit act routine <slug>`, above). Listed: the client's own literal sends.
 */
export const HUB_ACT_ONLY: Readonly<Record<string, { readonly actions: ReadonlySet<string>; readonly what: string }>> =
  {
    routines: {
      actions: new Set([
        "read", // routines.js:285
        "read_all", // routines.js:289
        "request_refresh", // routines.js:297
        "update", // routines.js:361
        "add", // routines.js:361
        "stop", // routines.js:929
        "pause", // routines.js:940
        "model", // routines.js:943
        "looked", // routines.js:135
      ]),
      what: "Running a routine",
    },
  };

/**
 * The action, in any app, whose first argument is a URL to open (inbox.js:328, a hub-provided action in
 * monitor.js:53; `hub.js:122-126` opens it locally). Never sent to the hub: an http(s) URL goes to the device that asked
 * as a toast with a link (U3, as E11) and the connection gets {@link hubOpenedReply}; anything else is refused.
 */
export const HUB_OPEN_URL_ACTION = "open_url";

/**
 * The answer line the bridge gives an intercepted `open_url`: what `hub.js:125` answers when it opened the URL itself
 * (mail.js:157 and meetings.js:203 keep quiet about a note starting with "opened ").
 */
export function hubOpenedReply(url: string): string {
  return `${JSON.stringify({ note: `opened ${url}`, pending: {}, refreshing: {} })}\n`;
}

/** Longest request line, complete or still being written (UTF-8 bytes, without its `\n`). */
export const HUB_LINE_MAX_BYTES = 1024 * 1024;
