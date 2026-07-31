import { expect, test } from "@playwright/test";
import { clearStorage } from "./helpers";

/**
 * The folder screen is the FIRST thing a visitor sees in a browser that has the File
 * System Access API. It offered one button and no way past it, and silently swallowed a
 * cancelled picker — so dismissing the dialog left you on a page that appeared broken.
 */
test.describe("Startup: choosing where data is saved", () => {
  test("offers a way past the folder screen", async ({ page }) => {
    await page.goto("/index.html");
    await clearStorage(page);
    await page.goto("/index.html");

    await expect(page.locator("#startupFolderView")).toBeVisible();
    await expect(page.locator("#startupSelectFolderBtn")).toBeVisible();
    await expect(page.locator("#startupSkipFolderBtn")).toBeVisible();
  });

  test("continuing without a folder reaches the main menu", async ({ page }) => {
    await page.goto("/index.html");
    await clearStorage(page);
    await page.goto("/index.html");

    await page.locator("#startupSkipFolderBtn").click();

    await expect(page.locator("#startupMainView")).toBeVisible();
    await expect(page.locator("#startupCreateBtn")).toBeVisible();
    await expect(page.locator("#startupFolderView")).toBeHidden();
  });

  test("a cancelled picker says so instead of doing nothing", async ({ page }) => {
    await page.goto("/index.html");
    await clearStorage(page);
    await page.addInitScript(() => {
      // Reproduce a dismissed native dialog.
      // @ts-expect-error — overriding an optional platform API
      window.showDirectoryPicker = () =>
        Promise.reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }));
    });
    await page.goto("/index.html");

    await page.locator("#startupSelectFolderBtn").click();

    // Previously: console.log only, nothing on screen.
    await expect(page.locator("#startupError")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#startupError")).toContainText(/without a folder/i);
  });

  test("still lets you build a board after skipping", async ({ page }) => {
    await page.goto("/index.html");
    await clearStorage(page);
    await page.goto("/index.html");

    await page.locator("#startupSkipFolderBtn").click();
    await page.locator("#startupCreateBtn").click();
    await page.locator("#startupName").fill("No Folder Board");
    await page.locator("#startupRole").selectOption({ index: 1 });
    await page.locator("#startupUserColor").selectOption({ index: 1 });
    await page.locator("#startupUserShape").selectOption({ index: 1 });
    await page.locator("#startupCapacity").selectOption({ index: 1 });
    await page.locator("#startupCreateSubmitBtn").click();

    await expect(page.locator("#startupModal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator(".lane")).toHaveCount(5);
  });
});
