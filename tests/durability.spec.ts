import { expect, test } from "@playwright/test";
import { addCard, fillRequiredCardFields, laneCards, openBoard } from "./helpers";

/**
 * Does work actually survive coming back later?
 *
 * The app writes through two stores: localStorage (fast, synchronous) and OPFS/IndexedDB
 * via StorageAdapter (what startup reads). Ordinary edits used to reach ONLY the first
 * of those, and the localStorage->OPFS migration only runs while OPFS is still empty —
 * so after the very first visit, every card and lane was written somewhere the app would
 * never read again. It looked saved. It was gone on the next visit.
 *
 * These tests assert the user-visible promise (my work is still here) rather than any
 * particular storage mechanism, so they keep their meaning if the storage layer changes.
 */
test.describe("Work survives leaving and coming back", () => {
  test("a card is still there after a reload", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Survives reload");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(laneCards(page, "backlog")).toHaveCount(1);

    await page.reload();
    // Returning visitors go through the startup modal again; continue into the board.
    await page.locator("#startupContinueBtn").click({ timeout: 15000 }).catch(() => {});
    await page.locator("#startupUserContinueBtn").click({ timeout: 5000 }).catch(() => {});

    await expect(page.locator(".lane")).not.toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText("Survives reload")).toBeVisible({ timeout: 20000 });
  });

  test("the durable store is written on an ordinary edit, not just at logout", async ({ page }) => {
    await openBoard(page);

    // Snapshot what the store holds before any board edit.
    const before = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("profiles", { create: true });
      let newest = 0;
      // @ts-expect-error — values() exists where OPFS does
      for await (const entry of dir.values()) {
        const f = await entry.getFile();
        newest = Math.max(newest, f.lastModified);
      }
      return newest;
    });

    await addCard(page, "backlog", "Triggers a durable write");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

    // Saves are debounced (750ms / 3 mutations), so wait for the store itself to move.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle("profiles", { create: true });
            let newest = 0;
            // @ts-expect-error — values() exists where OPFS does
            for await (const entry of dir.values()) {
              const f = await entry.getFile();
              newest = Math.max(newest, f.lastModified);
            }
            return newest;
          }),
        { timeout: 15000, message: "an ordinary card edit must reach durable storage" },
      )
      .toBeGreaterThan(before);
  });

  test("a lane rename survives a reload", async ({ page }) => {
    await openBoard(page);
    const title = page.locator('.lane-title[data-lane-id="ready"]');
    await title.click();
    await title.fill("Queued");
    await title.blur();
    await expect(title).toHaveText("Queued");

    await page.reload();
    await page.locator("#startupContinueBtn").click({ timeout: 15000 }).catch(() => {});
    await page.locator("#startupUserContinueBtn").click({ timeout: 5000 }).catch(() => {});

    await expect(page.locator('.lane-title[data-lane-id="ready"]')).toHaveText("Queued", {
      timeout: 20000,
    });
  });
});
