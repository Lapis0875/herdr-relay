// `herdr`: the 44 functions of fixtures/herdr-home/herdr.d.ts. Sync getters read the snapshot the bridge pushes
// (`boot`/`state`/`shared`); effects go to the bridge as `emit`, async calls as `rpc`, and the bridge applies its own
// policy (the host has no other way out). Both carry the current copy and the device session it came from.

import { currentCopy, emit, host, markAllDirty, nextCommand as nextCopyCommand, rpc, unsupported } from "../runtime.js";

const snap = (key) => structuredClone(host.state?.[key] ?? null);
let localSeq = 0;
const localId = (p) => `${p}-${host.state?.folder ?? "mod"}-${++localSeq}`;
const rejected = (name) => Promise.reject(unsupported("herdr", name));

export const exec = (command, args = [], options = {}) =>
  rpc("exec", [String(command), (args ?? []).map(String), options ?? {}]);
export const hc = (args) => rpc("hc", [(args ?? []).map(String)]);
export const home = () => host.state.home;
export const appHome = () => host.state.appHome;
export const readTextFile = (path, options) => rpc("readTextFile", [String(path), options ?? null]);
export const writeTextFile = (path, text, expected) =>
  rpc("writeTextFile", [String(path), String(text), expected ?? null]);
export const knownAgents = (options) => rpc("knownAgents", [options ?? null]);
export const pickFolder = () => rejected("pickFolder");
export function playSound(sound) {
  emit("playSound", [String(sound)]);
  return null;
}
export function run(name, args) {
  emit("run", [String(name), args ?? null]);
  return null;
}
export const machines = () => snap("machines");
export const spaces = () => snap("spaces");
export const agents = () => snap("agents");
export const panes = () => snap("panes");
export function setAgentOrder(addresses) {
  emit("setAgentOrder", [addresses]);
  return null;
}
export const terminals = () => snap("terminals");
export const focused = () => snap("focused");
export const layout = () => snap("layout");
export const layouts = () => snap("layouts");
export const commands = () => snap("commands");
export const window = () => snap("window");
export const placement = () => structuredClone(currentCopy("placement").placement ?? null);
export const theme = () => snap("theme");
export const themes = () => snap("themes");
export const fonts = () => snap("fonts");
export const updates = () => snap("updates");
export function presentUpdateNotes() {
  throw unsupported("herdr", "presentUpdateNotes");
}
export const telemetry = () => null;
export function feedbackPreview() {
  throw unsupported("herdr", "feedbackPreview");
}
export function feedbackPasteImage() {
  throw unsupported("herdr", "feedbackPasteImage");
}
export const feedbackPickImages = () => rejected("feedbackPickImages");
export function feedbackAttachImages() {
  throw unsupported("herdr", "feedbackAttachImages");
}
export function feedbackClearImages() {
  throw unsupported("herdr", "feedbackClearImages");
}
export const sendFeedback = () => rejected("sendFeedback");
export const settings = () => snap("settings");
export const keys = () => snap("keys");
export function openOverlay(spec) {
  const id = localId("overlay");
  emit("openOverlay", [id, spec]);
  return id;
}
export function closeOverlay(id) {
  emit("closeOverlay", [id]);
  return null;
}
export function notify(n) {
  const id = localId("notification");
  emit("notify", [id, n]);
  return id;
}
export const props = () => currentCopy("props").props;
export function shared(key) {
  const v = host.state?.shared?.[key];
  return v === undefined ? null : structuredClone(v);
}
/** Every mod sees it and setting re-renders all (AGENTS.md): applied locally at once, then sent to the bridge. */
export function setShared(key, value) {
  const k = String(key);
  const changed = JSON.stringify(host.state.shared[k] ?? null) !== JSON.stringify(value ?? null);
  host.state.shared[k] = structuredClone(value);
  emit("setShared", [k, value]);
  if (changed) markAllDirty();
  return null;
}
/**
 * Copy-scoped: the copy is read from the async context at call time, so a loop of `await nextCommand()` receives its
 * own copy's commands, and what it does after each one carries the session that sent that command.
 */
export const nextCommand = () => nextCopyCommand();
export const watchFolder = (path) => rpc("watchFolder", [String(path)]);
