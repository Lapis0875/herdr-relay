import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "screens.spec.js",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  projects: [
    { name: "iphone-15", use: { ...devices["iPhone 15"] } },
    {
      name: "ipad-air",
      use: {
        ...devices["iPad (gen 7)"],
        viewport: { width: 820, height: 1180 },
        screen: { width: 820, height: 1180 },
      },
    },
    {
      name: "pixel-8",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 393, height: 852 },
        screen: { width: 393, height: 852 },
        userAgent: devices["Pixel 7"].userAgent.replace("Pixel 7", "Pixel 8"),
      },
    },
  ],
});
