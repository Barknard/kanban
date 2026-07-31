import { expect, type Page } from "@playwright/test";

/**
 * Boots the app to a usable board.
 *
 * Two things have to be handled before any test can run:
 *
 *  1. `StartupModal.show()` checks `window.showDirectoryPicker`. In Chromium that
 *     exists, so the app opens the folder-picker view and calls a NATIVE OS dialog
 *     Playwright cannot drive. Deleting the API before load forces the IndexedDB/OPFS
 *     path, which is also what Firefox and mobile browsers get — i.e. the path most
 *     real visitors to the Pages site will use.
 *  2. Storage must be empty, or a previous test's profile decides what this one sees.
 */
export async function openBoard(page: Page) {
  await page.addInitScript(() => {
    // @ts-expect-error — deliberately removing an optional platform API
    delete window.showDirectoryPicker;
    // @ts-expect-error — same, so no code path tries to open a save dialog either
    delete window.showSaveFilePicker;
    // @ts-expect-error
    delete window.showOpenFilePicker;
  });

  await page.goto("/index.html");
  await clearStorage(page);
  await page.goto("/index.html");

  const modal = page.locator("#startupModal");
  await expect(modal).toBeVisible({ timeout: 15000 });

  // No profiles exist on a clean slate, so go straight to creating one.
  await page.locator("#startupCreateBtn").click();
  await expect(page.locator("#startupCreateForm")).toBeVisible();

  await page.locator("#startupName").fill("Test Board");
  await page.locator("#startupRole").selectOption({ index: 1 });
  await page.locator("#startupUserColor").selectOption({ index: 1 });
  await page.locator("#startupUserShape").selectOption({ index: 1 });
  await page.locator("#startupCapacity").selectOption({ index: 1 });

  await page.locator("#startupCreateSubmitBtn").click();
  await expect(modal).toBeHidden({ timeout: 15000 });
  await expect(page.locator("#lanes")).toBeVisible();
}

/** Wipes localStorage, IndexedDB and OPFS so each test starts from nothing. */
export async function clearStorage(page: Page) {
  await page.evaluate(async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    for (const name of ["gm-kanban", "app_profiles"]) {
      await new Promise<void>((resolve) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = () => resolve();
        r.onblocked = () => resolve();
      });
    }
    try {
      const root = await navigator.storage.getDirectory();
      // @ts-expect-error — values() is available where OPFS is
      for await (const entry of root.values()) {
        await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
      }
    } catch {
      /* OPFS unavailable — nothing to clean */
    }
  });
}

/** Adds a card to a lane and returns its locator. */
export async function addCard(page: Page, laneId: string, title: string) {
  await page.locator(`.lane[data-lane-id="${laneId}"] .lane-body`).dblclick();
  const dialog = page.locator("#cardDialog");
  await expect(dialog).toBeVisible();
  await page.locator("#cardTitle").fill(title);
  return dialog;
}

/**
 * Fills everything the save validation insists on.
 *
 * A fresh profile has empty people rosters, so Developer and Requestor — both required
 * — have nothing to select until someone is added. The card dialog's own "+" buttons
 * are the supported way to do that, so the tests use them rather than reaching into
 * app state.
 */
export async function fillRequiredCardFields(page: Page) {
  // Problem / Outcome / Impact each need at least five words.
  await page.locator("#cardProblem").fill("Users cannot complete the checkout flow reliably");
  await page.locator("#cardOutcome").fill("Customers can finish a purchase without errors");
  await page.locator("#cardImpact").fill("Revenue stops leaking from abandoned broken carts");

  await ensureSelected(page, "#cardDeveloper", "#addDeveloperBtn", "#newDeveloperName", "#createDeveloperBtn", "Dev Person");
  await ensureSelected(page, "#cardRequestor", "#addRequestorBtn", "#newRequestorName", "#createRequestorBtn", "Req Person");
}

/** Picks an existing option, creating one through the "+" dialog if the list is empty. */
async function ensureSelected(
  page: Page,
  selectSel: string,
  addBtnSel: string,
  nameInputSel: string,
  createBtnSel: string,
  name: string,
) {
  const select = page.locator(selectSel);
  const options = await select.locator("option").count();

  // Option 0 is the empty placeholder.
  if (options <= 1) {
    await page.locator(addBtnSel).click();
    await page.locator(nameInputSel).fill(name);
    await page.locator(createBtnSel).click();
    await expect(page.locator(nameInputSel)).toHaveCount(0, { timeout: 10000 });
  }

  await select.selectOption({ index: 1 });
}

/** Adds a person to the shared assignee roster so Assignee dropdowns are populated. */
export async function addAssignee(page: Page, name: string) {
  await page.locator("#addAssigneeBtn").click();
  await page.locator("#newAssigneeName").fill(name);
  await page.locator("#createAssigneeBtn").click();
}

/** Creates a fully-valid card in a lane and closes the dialog. */
export async function createCard(page: Page, laneId: string, title: string) {
  await addCard(page, laneId, title);
  await fillRequiredCardFields(page);
  await page.locator("#cardSaveBtn").click();
  await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
}

export function laneCards(page: Page, laneId: string) {
  return page.locator(`.lane[data-lane-id="${laneId}"] .card`);
}
