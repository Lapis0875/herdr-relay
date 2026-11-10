import { assertEquals } from "@std/assert";
import { type Access, gate, isDocumentNavigation } from "../../../src/auth/gate.ts";

const config = {
  port: 7781,
  token: "test-token",
  tailnet: { owner: "owner@example.com", dns: "machine.example.ts.net" },
  tailnetEnabled: true,
  extraLoopbackHosts: [],
};

Deno.test("document navigation requires a safe method, navigate mode, document destination and no Origin", () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "OPTIONS"]) {
    for (const mode of ["navigate", "cors", "no-cors", "same-origin", null]) {
      for (const dest of ["document", null, "iframe", "frame", "empty", "script"]) {
        for (const origin of [null, "https://evil.example", ""]) {
          const headers = new Headers();
          if (mode !== null) headers.set("sec-fetch-mode", mode);
          if (dest !== null) headers.set("sec-fetch-dest", dest);
          if (origin !== null) headers.set("origin", origin);
          const expected = (method === "GET" || method === "HEAD") && mode === "navigate" &&
            (dest === null || dest === "document") && origin === null;
          assertEquals(isDocumentNavigation(method, headers), expected, `${method} ${mode} ${dest} ${origin}`);
        }
      }
    }
  }
});

Deno.test("navigate access behaves like read for same-origin and none, but only accepts GET and HEAD", async () => {
  const run = (method: string, site: string, access: Access) =>
    gate({
      method,
      access,
      headers: new Headers({ host: "127.0.0.1:7781", "sec-fetch-site": site }),
      token: false,
      peerTrusted: () => Promise.resolve(true),
    }, config);
  for (const site of ["same-origin", "none"]) {
    for (const method of ["GET", "HEAD"]) {
      assertEquals(await run(method, site, "navigate"), await run(method, site, "read"), `${site} ${method}`);
      assertEquals((await run(method, site, "navigate")).ok, true);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      assertEquals(await run(method, site, "navigate"), { ok: false, status: 405, why: "GET only" });
    }
  }
  assertEquals(await run("OPTIONS", "cross-site", "navigate"), {
    ok: false,
    status: 403,
    why: "no cross-site requests",
  });
});
