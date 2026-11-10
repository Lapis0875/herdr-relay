// `net`: Herdr's capability-gated TCP client. The mod host has no net permission beyond its control port; the bridge
// opens the socket after checking host/port against its allowlist (the cockpit hub's port from hub.json) and relays
// bytes (`net.read` answers base64, or null at end of stream).

import { emit, rpc } from "../runtime.js";

const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function connect(host, port) {
  const id = await rpc("net.connect", [String(host), Number(port)]);
  return {
    write: (data) => rpc("net.write", [id, String(data)]).then(() => undefined),
    read: async (maxBytes = 65536) => {
      const b64 = await rpc("net.read", [id, Number(maxBytes)]);
      return b64 === null ? null : decode(b64);
    },
    close: () => emit("net.close", [id]),
  };
}

export default { connect };
