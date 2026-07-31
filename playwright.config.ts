import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: "http://127.0.0.1:8791",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      // A narrow touch viewport rather than a full device profile.
      // Playwright's phone descriptors lay the page out at a larger CSS viewport and
      // scale it down (innerWidth 673 for a 412px screen), which makes precise click
      // targeting unreliable and tests the emulator more than the stylesheet. A plain
      // small viewport with touch enabled exercises the responsive CSS honestly.
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false },
    },
  ],

  webServer: {
    command: "npx http-server -p 8791 -a 127.0.0.1 --silent .",
    url: "http://127.0.0.1:8791/index.html",
    // Always start fresh so the suite can never test a stale copy of the page.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
