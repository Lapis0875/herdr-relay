import { assert, assertEquals } from "@std/assert";
import { PUSH_SUBJECT_ENV, subjectOverride, subjectProblem, vapidSubject } from "../../../src/push/subject.ts";

Deno.test("VAPID subject prefers a valid environment override to MagicDNS and the project fallback", () => {
  for (const value of ["mailto:push@example.com", "https://push.example.com/contact"]) {
    const logs: string[] = [];
    const override = subjectOverride((line) => logs.push(line), (name) => {
      assertEquals(name, PUSH_SUBJECT_ENV);
      return value;
    });
    assertEquals(subjectProblem(value), null);
    assertEquals(override, value);
    assertEquals(vapidSubject(override, "mac.tailnet.ts.net"), value);
    assertEquals(vapidSubject(override, null), value);
  }
  assertEquals(vapidSubject(null, "mac.tailnet.ts.net"), "https://mac.tailnet.ts.net");
  assertEquals(vapidSubject(null, null), "https://github.com/Lapis0875/herdr-relay");
});

Deno.test("invalid VAPID subject overrides are logged and ignored", () => {
  for (
    const value of [
      "http://example.com/contact",
      "https://localhost/contact",
      "mailto:me@localhost",
      "not a URL",
      "https://127.0.0.1/",
      "https://user:password@example.com/",
    ]
  ) {
    const logs: string[] = [];
    assert(subjectProblem(value) !== null);
    const override = subjectOverride((line) => logs.push(line), () => value);
    assertEquals(override, null);
    assert(logs.some((line) => line.includes(PUSH_SUBJECT_ENV) && line.includes("ignored")));
    assertEquals(vapidSubject(override, "mac.tailnet.ts.net"), "https://mac.tailnet.ts.net");
    assertEquals(vapidSubject(override, null), "https://github.com/Lapis0875/herdr-relay");
  }
});

Deno.test("an unset or empty override falls back without an invalid-value log", () => {
  for (const value of [undefined, ""]) {
    const logs: string[] = [];
    assertEquals(subjectOverride((line) => logs.push(line), () => value), null);
    assertEquals(logs, []);
  }
});
