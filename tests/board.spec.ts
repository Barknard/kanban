import { expect, test } from "@playwright/test";
import { addCard, createCard, fillRequiredCardFields, laneCards, openBoard } from "./helpers";

test.describe("Boot", () => {
  test("opens with the default five lanes and no page errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await openBoard(page);

    await expect(page.locator(".lane")).toHaveCount(5);
    for (const id of ["backlog", "ready", "progress", "review", "done"]) {
      await expect(page.locator(`.lane[data-lane-id="${id}"]`)).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("does not leave a broken image when the logo is missing", async ({ page }) => {
    // A configured-but-absent icon used to throw InvalidStateError from drawImage.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/simple-kanban-logo.gif", (r) => r.abort());
    await openBoard(page);
    expect(errors.filter((e) => /drawImage|InvalidState/i.test(e))).toEqual([]);
  });
});

test.describe("Lanes", () => {
  test("adds a lane", async ({ page }) => {
    await openBoard(page);
    await page.locator("#addLaneBtn").click();
    await page.locator("#newLaneName").fill("Testing");
    await page.locator("#createLaneBtn").click();
    await expect(page.locator(".lane")).toHaveCount(6);
    await expect(page.locator('.lane[data-lane-id="testing"]')).toBeVisible();
  });

  test("rejects a duplicate lane name", async ({ page }) => {
    await openBoard(page);
    await page.locator("#addLaneBtn").click();
    await page.locator("#newLaneName").fill("Ready");
    await page.locator("#createLaneBtn").click();
    await expect(page.locator(".lane")).toHaveCount(5);
  });

  test("renames a lane inline", async ({ page }) => {
    await openBoard(page);
    const title = page.locator('.lane-title[data-lane-id="ready"]');
    await title.click();
    await title.fill("Queued");
    await title.blur();
    await expect(title).toHaveText("Queued");
  });

  test("deletes an empty lane", async ({ page }) => {
    await openBoard(page);
    page.on("dialog", (d) => d.accept());
    await page.locator('.lane-btn[data-action="delete"][data-lane-id="review"]').click();
    await expect(page.locator('.lane[data-lane-id="review"]')).toHaveCount(0);
  });

  test("sets a WIP limit and flags the lane when it is exceeded", async ({ page }) => {
    await openBoard(page);
    await page.locator('.wip-editable[data-lane-id="backlog"]').click();
    await page.locator("#wipLimitInput").fill("1");
    await page.locator("#saveWipBtn").click();
    await expect(page.locator('.lane[data-lane-id="backlog"] .wip-badge')).toContainText("/1");
  });

  test("WIP display preference 'none' actually hides the count", async ({ page }) => {
    // The preference set a CSS variable no rule ever read, so it did nothing at all.
    await openBoard(page);
    await page.locator("#prefsBtn").click();
    await page.locator("#prefWipDisplay").selectOption("none");
    await page.locator("#prefsSaveBtn").click();

    const badge = page.locator('.lane[data-lane-id="backlog"] .wip-badge');
    await expect(badge).not.toContainText("/");
  });
});

test.describe("Cards", () => {
  test("creating a card requires the essential fields", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Fix checkout");
    await page.locator("#cardSaveBtn").click();
    // Problem/Outcome/Impact are each required with at least five words.
    await expect(page.locator("#cardDialog")).toBeVisible();
  });

  test("saves a card once the essential fields are filled", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Fix checkout");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(laneCards(page, "backlog")).toHaveCount(1);
  });

  test("refuses to start a card that is missing its planning fields", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Half-baked");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

    await page.locator('.card-action-btn[data-action="start"]').first().click();
    // Assignee/Effort/Due/Priority/Risk are all still empty, so it must not move.
    await expect(laneCards(page, "progress")).toHaveCount(0);
  });

  test("card action buttons carry accessible names", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "A11y card");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

    // These used to expose only an emoji glyph to screen readers.
    const start = page.locator('.card-action-btn[data-action="start"]').first();
    await expect(start).toHaveAttribute("aria-label", /.+/);
  });
});

test.describe("Filters", () => {
  test("search narrows the visible cards", async ({ page }) => {
    await openBoard(page);
    for (const title of ["Alpha task", "Beta task"]) {
      await addCard(page, "backlog", title);
      await fillRequiredCardFields(page);
      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    }
    await expect(laneCards(page, "backlog")).toHaveCount(2);

    await page.locator("#filterSearch").fill("Alpha");
    await expect(laneCards(page, "backlog")).toHaveCount(1);
  });

  test("'Mine Only' keeps the cards assigned to me", async ({ page }) => {
    // The filter compared STATE.meUser (a userId like `user_a1b2c3d4`) against
    // card.assignee (a person's NAME). Those can never be equal, so switching the chip
    // on hid every card on the board.
    await openBoard(page);

    // Whoever the app considers "me" — the assignee has to match this exactly.
    // The startup flow caches this identity; the #meBtn dropdown is not reliably
    // pre-selected, which is precisely what made this filter unusable.
    const meName = await page.evaluate(
      () => JSON.parse(localStorage.getItem("kanban-userProfile") || "{}").name ?? "",
    );
    expect(meName).not.toBe("");

    await addCard(page, "backlog", "Assigned to me");
    await fillRequiredCardFields(page);

    // Assignee lives in the Planning section, which is collapsed by default.
    await page.locator('.dialog-section-header[data-section="planning"]').click();
    await expect(page.locator("#addAssigneeBtn")).toBeVisible();

    // addAssigneeFromCard() asks for a name, then a capacity, via two prompt() calls.
    let prompts = 0;
    page.on("dialog", (d) => d.accept(prompts++ === 0 ? meName : "10"));
    await page.locator("#addAssigneeBtn").click();

    // Adding does not auto-select, so choose the new person explicitly.
    const assignee = page.locator("#cardAssignee");
    await expect(assignee.locator("option")).not.toHaveCount(1, { timeout: 10000 });
    await assignee.selectOption({ index: 1 });
    await expect(assignee).toHaveValue(meName);

    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(page.locator(".card")).toHaveCount(1);

    await page.locator("#filterMine").click();
    await expect(page.locator("#filterMine")).toHaveAttribute("aria-pressed", "true");
    // The regression: this used to be 0.
    await expect(page.locator(".card")).toHaveCount(1);
  });

  test("filter chips are keyboard operable", async ({ page }) => {
    await openBoard(page);
    const chip = page.locator("#filterBlocked");
    await expect(chip).toHaveAttribute("role", "button");
    await expect(chip).toHaveAttribute("tabindex", "0");

    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  test("Space also activates a chip", async ({ page }) => {
    await openBoard(page);
    const chip = page.locator("#filterDueWeek");
    await chip.focus();
    await page.keyboard.press(" ");
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Undo and redo", () => {
  test("Ctrl+Z inside a text field does not revert the whole board", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Typing test");

    const field = page.locator("#cardProblem");
    await field.fill("Users cannot complete the checkout flow reliably");
    await field.focus();
    await page.keyboard.press("Control+z");

    // The dialog must still be open — the app's undo used to fire and revert the board
    // out from under the open card.
    await expect(page.locator("#cardDialog")).toBeVisible();
  });
});

test.describe("Data safety", () => {
  test("never claims a save succeeded when storage is full", async ({ page }) => {
    await openBoard(page);

    // Force every localStorage write to fail the way a full quota does.
    await page.evaluate(() => {
      const err = new DOMException("Quota exceeded", "QuotaExceededError");
      Storage.prototype.setItem = () => {
        throw err;
      };
    });

    await addCard(page, "backlog", "Doomed write");
    await fillRequiredCardFields(page);
    await page.locator("#cardSaveBtn").click();

    // The status pill used to say "Saved at HH:MM:SS" regardless.
    const status = page.locator("#saveStatus, .save-status").first();
    if (await status.count()) {
      await expect(status).not.toContainText(/^Saved at/);
    }
  });

  test("survives a corrupt user profile in localStorage", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.addInitScript(() => {
      // @ts-expect-error — removing an optional platform API
      delete window.showDirectoryPicker;
      localStorage.setItem("kanban-userProfile", "{not valid json");
    });
    await page.goto("/index.html");

    // An unguarded JSON.parse here used to throw on a hot path.
    await expect(page.locator("#startupModal")).toBeVisible({ timeout: 15000 });
    expect(errors.filter((e) => /JSON/i.test(e))).toEqual([]);
  });
});

test.describe("Progressive web app", () => {
  test("serves a manifest with real icons", async ({ page, request }) => {
    await page.goto("/index.html");
    const res = await request.get("/manifest.json");
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toBe("Simple Kanban");
    for (const icon of manifest.icons) {
      const r = await request.get(icon.src.replace(/^\.\//, "/"));
      expect(r.ok(), `${icon.src} should exist`).toBeTruthy();
    }
  });

  test("makes no third-party requests", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname)) external.push(r.url());
    });
    await openBoard(page);
    expect(external).toEqual([]);
  });
});
