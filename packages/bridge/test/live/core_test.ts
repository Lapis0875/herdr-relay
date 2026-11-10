import { delay } from "@std/async";
import { assert, assertEquals } from "@std/assert";
import { CoreClient } from "../../src/core/client.ts";

// This test never sends input, resize, doc.set or terminal.run. The subscription is
// established by CoreClient.ready() and lives for less than three seconds.
Deno.test({
  name: "live core: generation 1 read-only discovery, snapshot and observe",
  ignore: Deno.env.get("HERDR_RELAY_LIVE_CORE") !== "1",
  async fn() {
    const client = new CoreClient({ timeoutMs: 5000 });
    const deadline = setTimeout(() => void client.close(), 2800);
    try {
      const session = await client.ready();
      assertEquals(session.hello.generation, 1);
      assertEquals(session.hello.framed, true);
      const schema = await client.discover();
      assert(schema.methods.some((method) => method.name === "events.subscribe"));
      const document = await client.docGet("herdr-app");
      assertEquals(typeof document.version, "number");
      const list = await client.terminalList();
      assert(Array.isArray(list.terminals));
      const terminal = list.terminals.find((item) => item.state === "live");
      if (terminal) {
        const facts = await client.terminalGet(terminal.address);
        assertEquals(facts.address, terminal.address);
        const stream = await client.attach(terminal.address, { mode: "observe", onData: () => {} });
        try {
          await delay(500);
        } finally {
          stream.close();
          await stream.closed;
        }
      } else {
        console.log("No live terminals: terminal.get and observe attach not exercised");
      }
    } finally {
      clearTimeout(deadline);
      await client.close();
    }
  },
});
