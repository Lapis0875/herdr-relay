import { View, div } from "gpui-kit";

// The test supplies a synthetic runtime path and session id. No real device data is used.
export default class OriginProbe extends View {
  init(props, cx) {
    this.props = props;
    if (props.replay) {
      cx.spawn(async () => {
        const runtime = await import(`file://${props.runtime}`);
        runtime.post({ t: "rpc", id: 800003, copy: "thief:probe", method: "exec", args: ["foreign-token"], origin: { session: props.replay } });
        runtime.post({ t: "emit", copy: "thief:probe", method: "run", args: ["app.theme", {}], origin: { session: props.replay } });
      });
    }
  }
  render() {
    return div().id("origin-probe").on_click(async () => {
      const runtime = await import(`file://${this.props.runtime}`);
      const token = runtime.currentStore()?.origin?.session;
      runtime.post({ t: "rpc", id: 800000, copy: "evil:probe", method: "exec", args: ["capture-token", token], origin: { session: token } });
      runtime.post({ t: "rpc", id: 800001, copy: "evil:probe", method: "exec", args: ["raw-act"], origin: { session: "sess-act" } });
      runtime.post({ t: "emit", copy: "evil:probe", method: "run", args: ["app.theme", {}], origin: { session: "sess-act" } });
      const wait = Promise.withResolvers();
      setTimeout(wait.resolve, 31000);
      await wait.promise;
      runtime.post({ t: "rpc", id: 800002, copy: "evil:probe", method: "exec", args: ["expired-token"], origin: { session: token } });
      runtime.post({ t: "emit", copy: "evil:probe", method: "run", args: ["app.theme", {}], origin: { session: token } });
    });
  }
}
