import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const output = fileURLToPath(
  new URL("../../.tmp/devices/playwright/", import.meta.url),
);
const base = process.env.BASE_URL;
const token = process.env.TOKEN;
if (!base || !token) {
  throw new Error(
    "Set BASE_URL and TOKEN for an already-running development bridge",
  );
}
const url = new URL("/herdr-relay/", base);
if (
  url.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
) {
  throw new Error("BASE_URL must be a loopback HTTP URL");
}
url.searchParams.set("token", token);

test(
  "navigates the recomposed graph and observes a terminal",
  async ({ page }, testInfo) => {
    const errors = [];
    const sent = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        try {
          sent.push(JSON.parse(payload));
        } catch { /* binary or non-JSON frames are not protocol messages */ }
      }));
    await mkdir(output, { recursive: true });
    const shot = (name) =>
      page.screenshot({
        path: path.join(output, `${testInfo.project.name}-${name}.png`),
      });
    await page.goto(url.href);
    await expect(page.locator(".nav")).toBeVisible();
    await expect(page.locator(".shell-button")).toHaveAttribute(
      "aria-label",
      /connected/i,
    );
    if (await page.locator('.layer--push[aria-label="Panel"]').isVisible()) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.locator('.layer--push[aria-label="Panel"]')).not
        .toBeVisible();
    }
    if (await page.locator('.side__panel[aria-label="Panel"]').isVisible()) {
      await page.getByRole("button", { name: "Close Panel" }).click();
      await expect(page.locator('.side__panel[aria-label="Panel"]')).not
        .toBeVisible();
    }
    await shot("home");

    if (testInfo.project.name !== "ipad-air") {
      const drawer = page.locator(".shell-button");
      await drawer.click();
      await expect(page.locator('.side--drawer [role="dialog"]')).toBeVisible();
      await shot("drawer");
      await page.keyboard.press("Escape");
      await expect(page.locator('.side--drawer [role="dialog"]')).not
        .toBeVisible();

      const segments = page.locator('nav.segments[data-placement="bottom"]');
      await expect(segments).toBeVisible();
      const more = segments.getByRole("button", { name: "More", exact: true });
      await more.click();
      const sheet = page.getByRole("dialog", { name: /^More in / });
      await expect(sheet).toBeVisible();
      await shot("more");
      const option = sheet.getByRole("list").getByRole("button").first();
      const optionName = (await option.innerText()).trim();
      await option.click();
      await expect(sheet).not.toBeVisible();
      await expect(
        segments.getByRole("button", { name: optionName, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await segments.getByRole("button", { name: "Work", exact: true }).click();
      await expect(segments.getByRole("button", { name: "Work", exact: true }))
        .toHaveAttribute("aria-current", "page");
      const panel = page.locator('.sn-link[data-node="panel"]');
      await expect(panel).toBeVisible();
      await panel.click();
      await expect(page.locator('.layer--push[aria-label="Panel"]'))
        .toBeVisible();
      await shot("panel");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.locator('.layer--push[aria-label="Panel"]')).not
        .toBeVisible();
    } else {
      await expect(page.locator(".nav")).toHaveAttribute(
        "data-class",
        "tablet-portrait",
      );
      // Tablet stacks use their mod-provided controls; the fixture must start in Work.
      await expect(page.locator(".sn-panes")).toBeVisible();
      const panel = page.locator('.sn-link[data-node="panel"]');
      await expect(panel).toBeVisible();
      await panel.click();
      await expect(
        page.locator('.side__panel[role="dialog"][aria-label="Panel"]'),
      ).toBeVisible();
      await shot("panel");
      await page.getByRole("button", { name: "Close Panel" }).click();
      await expect(page.locator('.side__panel[aria-label="Panel"]')).not
        .toBeVisible();
    }

    const terminal = page.locator('.sn-panes .w-term[data-status="live"]')
      .first();
    await expect(terminal).toBeVisible();
    await expect(terminal.locator('[role="status"]')).toContainText(
      /Observing|Read-only/,
    );
    await expect.poll(() =>
      sent.some((message) =>
        message.t === "term.open" && message.mode === "observe"
      )
    ).toBe(true);
    expect(
      sent.filter((message) => message.t === "term.open").every((message) =>
        message.mode === "observe"
      ),
    ).toBe(true);
    await shot("terminal");
    expect(errors, "browser console errors and uncaught exceptions").toEqual(
      [],
    );
  },
);
