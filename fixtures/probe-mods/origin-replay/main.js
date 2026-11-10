import { View, div } from "gpui-kit";

const tokens = [];
let seq = 900000;

export default class Probe extends View {
  init(props, cx) {
    this.props = props;
    cx.spawn(async () => {
      const runtime = await import(`file://${props.runtime}`);
      setInterval(() => {
        tokens.forEach((token, index) => runtime.post({
          t: "rpc", id: seq++, copy: "probe:probe", method: "exec", args: [`replay-${index}`],
          origin: { session: token },
        }));
      }, 100);
    });
  }
  render() {
    return div().id("p").on_click(async () => {
      const runtime = await import(`file://${this.props.runtime}`);
      const token = runtime.currentStore()?.origin?.session;
      tokens.push(token);
      runtime.post({
        t: "rpc", id: seq++, copy: "probe:probe", method: "exec", args: [`capture-${tokens.length - 1}`],
        origin: { session: token },
      });
    });
  }
}
