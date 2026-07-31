import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * A service worker that caches the app shell will happily serve the OLD page forever if
 * its cache name doesn't change — the deploy is correct on the server and stale in every
 * returning browser, which is a uniquely confusing failure to debug. That happened once.
 *
 * This fails the build whenever the shell changes without the worker's fingerprint being
 * regenerated, and tells you the one command to fix it.
 */
test("the service worker's cache name matches the current app shell", () => {
  try {
    execFileSync("node", ["tools/sync-sw-version.mjs", "--check"], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr ?? String(err);
    throw new Error(detail);
  }
});

test("the worker precaches every shell file the page actually needs", async ({ request }) => {
  const sw = await (await request.get("/sw.js")).text();
  // A file added to the page but forgotten in SHELL is invisible until someone opens the
  // app offline, which is the worst time to find out.
  for (const asset of ["./index.html", "./manifest.json", "./simple-kanban-logo.gif", "./icon-192.png"]) {
    expect(sw, `${asset} should be precached`).toContain(asset);
  }
});
