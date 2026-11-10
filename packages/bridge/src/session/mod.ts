/** Device sessions: `run()` classes (DESIGN-v2 §2.4), navigator + layout interception and focus (DESIGN.md §3). */

export { type Classification, classifyCommand, parseAction } from "./commands.ts";
export {
  FOCUS_COMMANDS,
  type FocusCommand,
  isFocusCommand,
  SessionFocus,
  type SessionView,
  type SessionWorld,
} from "./focus.ts";
export {
  type NavOp,
  type RunContext,
  type RunOutcome,
  Session,
  type SessionEffect,
  type SessionOptions,
  type SessionOutcome,
} from "./session.ts";
