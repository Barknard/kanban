import { expect, test, type Page } from "@playwright/test";
import * as fs from "fs";
import {
  addCard,
  createCard,
  fillRequiredCardFields,
  laneCards,
  openBoard,
} from "./helpers";

/**
 * Realistic, multi-step sessions - each test is a believable run through the app, not an
 * isolated assertion. Per-control coverage lives in functions.spec.ts; this file is about
 * whole workflows and the state they leave behind.
 */

/**
 * Several flows below need to answer more than one native prompt() in a row (assignee
 * name then capacity, epic name then code, ...). Registering `page.on('dialog', ...)`
 * more than once stacks listeners - every one of them fires for the same dialog, and a
 * second `.accept()` on an already-handled dialog throws. This installs exactly ONE
 * listener for the whole test and lets call sites queue up the answers, in order, right
 * before they trigger the prompts.
 */
function makeDialogQueue(page: Page) {
  const queue: string[] = [];
  page.on("dialog", (d) => d.accept(queue.shift() ?? ""));
  return (...answers: string[]) => queue.push(...answers);
}

/**
 * Expands one of the card dialog's collapsible sections, unless it is already expanded.
 *
 * #cardDialog is a single static piece of markup reused for every card - it is never
 * rebuilt per card - so a section's collapsed/expanded state carries over from whichever
 * card most recently had its dialog open. Section headers *toggle*, so blindly clicking
 * one that a previous card already left open in the same test would collapse it instead.
 */
async function ensureSectionExpanded(page: Page, section: string) {
  const content = page.locator(`#content-${section}`);
  const isCollapsed = await content.evaluate((el) => el.classList.contains("collapsed"));
  if (isCollapsed) {
    await page.locator(`.dialog-section-header[data-section="${section}"]`).click();
  }
}

/** Opens the Planning section of the (already-open) card dialog. Assignee/Effort/Due/Risk live there. */
async function openPlanningSection(page: Page) {
  await ensureSectionExpanded(page, "planning");
}

/**
 * Opens a new card via the toolbar button rather than double-clicking a lane's body.
 *
 * addCard() (helpers.ts) double-clicks the CENTRE of the lane body's bounding box, which
 * is exactly right for the first card in an empty lane. Once several cards already sit in
 * that lane the centre point can land on one of them instead of the empty background, so
 * any test that builds up more than one or two cards in the same lane without moving them
 * elsewhere uses this instead - #addCardBtn always opens a fresh card in Backlog, with no
 * dependency on where existing cards happen to be laid out.
 */
async function addCardViaToolbar(page: Page, title: string) {
  await page.locator("#addCardBtn").click();
  const dialog = page.locator("#cardDialog");
  await expect(dialog).toBeVisible();
  await page.locator("#cardTitle").fill(title);
  return dialog;
}

test.describe("Flow: full card lifecycle", () => {
  test("a card travels Backlog -> In Progress -> Done and is then locked in place", async ({ page }) => {
    // The final drag runs Done -> Backlog, opposite corners of the board. Five lanes at
    // their default width already overflow the default viewport, and dragging across that
    // scroll boundary loses the drop target midway through the simulated mouse movement.
    await page.setViewportSize({ width: 2400, height: 900 });
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    await addCard(page, "backlog", "Checkout crashes on submit");
    await fillRequiredCardFields(page);

    // Priority lives in the always-expanded Essential section.
    await page.locator("#cardPriority").selectOption("High");

    // Assignee / Effort / Due date / Risk live in the collapsed Planning section.
    await openPlanningSection(page);
    await page.locator("#cardRisk").selectOption("Low");
    await page.locator('.effort-chip[data-value="5"]').click();
    await page.locator("#cardDueDate").fill("2026-12-31");

    queuePrompt("Priya", "8");
    await page.locator("#addAssigneeBtn").click();
    await page.locator("#cardAssignee").selectOption({ label: "Priya" });

    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(laneCards(page, "backlog")).toHaveCount(1);

    // Start: all five planning gates are satisfied, so this actually moves the card.
    await laneCards(page, "backlog").first().locator('.card-action-btn[data-action="start"]').click();
    await expect(laneCards(page, "progress")).toHaveCount(1);
    await expect(laneCards(page, "backlog")).toHaveCount(0);

    // Done requires Acceptance Criteria + Definition of Done, which this card doesn't have yet.
    await laneCards(page, "progress").first().locator('.card-action-btn[data-action="done"]').click();
    await expect(page.locator("#gmToast")).toContainText("Cannot mark as done");
    await expect(laneCards(page, "done")).toHaveCount(0);

    // Double-clicking anywhere on a card's body works, but the card's own bounding-box
    // centre can land on a badge or an action button depending on how much content it
    // has - the title is the one spot the app's own dblclick handler always honours.
    await laneCards(page, "progress").first().locator(".card-title").dblclick();
    await ensureSectionExpanded(page, "quality");
    await page.locator("#cardAc").fill("Given a valid cart, when I submit, then the order confirms");
    await page.locator("#cardDod").fill("Code reviewed, tests pass, deployed to production");
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

    await laneCards(page, "progress").first().locator('.card-action-btn[data-action="done"]').click();
    await expect(laneCards(page, "done")).toHaveCount(1);
    await expect(laneCards(page, "progress")).toHaveCount(0);

    // A completed card is locked into Done - dragging it elsewhere must be rejected.
    await laneCards(page, "done").first().dragTo(page.locator('.lane[data-lane-id="backlog"] .lane-body'));
    await expect(page.locator("#gmToast")).toContainText("Cannot move completed cards out of Done lane");
    await expect(laneCards(page, "done")).toHaveCount(1);
    await expect(laneCards(page, "backlog")).toHaveCount(0);
  });
});

test.describe("Flow: blocked and recovered", () => {
  test("blocking with a canned reason surfaces the card under Show Blocked, then unblocking restores it", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Needs vendor sign-off");
    await createCard(page, "backlog", "Unrelated card");

    const target = laneCards(page, "backlog").filter({ hasText: "Needs vendor sign-off" });
    await target.locator('.card-action-btn[data-action="block"]').click();
    await page.locator(".block-menu-item", { hasText: "Waiting for approval" }).click();

    await expect(target).toHaveClass(/card-blocked/);
    await expect(target.locator('.card-action-btn[data-action="unblock"]')).toBeVisible();

    await page.locator("#filterBlocked").click();
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card")).toContainText("Needs vendor sign-off");

    await target.locator('.card-action-btn[data-action="unblock"]').click();
    // The filter is still active, and the card is no longer blocked, so it drops out.
    await expect(page.locator(".card")).toHaveCount(0);

    await page.locator("#filterBlocked").click();
    await expect(page.locator(".card")).toHaveCount(2);
    await expect(target).not.toHaveClass(/card-blocked/);
  });
});

test.describe("Flow: sprint planning session", () => {
  test("filtering by epic and then by sprint narrows the board to the right cards", async ({ page }) => {
    await openBoard(page);

    await page.locator("#epicsBtn").click();
    await page.locator("#addNewEpic").click();
    await page.locator("#newEpicNameMenu").fill("Checkout Revamp");
    await page.locator("#newEpicCodeMenu").fill("CHK");
    await page.locator("#createEpicBtnMenu").click();
    await expect(page.locator("#gmToast")).toContainText('Epic "Checkout Revamp" created');
    // Creating an epic reopens the Manage Epics list dialog - close it before moving on.
    await page.locator("dialog[open] .dialog-close").last().click();

    // Manage Sprints reopens itself after each create, so "+ Add Sprint" is clicked twice
    // in a row without needing to re-open the toolbar dialog in between.
    await page.locator("#sprintsBtn").click();
    await page.locator("#addNewSprint").click();
    await page.locator("#sprintEpic").selectOption({ index: 0 });
    await page.locator("#sprintName").fill("Sprint 1");
    await page.locator("#sprintNumber").fill("1");
    await page.locator("#sprintDuration").fill("14");
    await page.locator("#sprintStartDate").fill("2026-08-01");
    await page.locator("#saveSprintBtn").click();
    await expect(page.locator("#gmToast")).toContainText('Sprint "Sprint 1" created');

    await page.locator("#addNewSprint").click();
    await page.locator("#sprintEpic").selectOption({ index: 0 });
    await page.locator("#sprintName").fill("Sprint 2");
    await page.locator("#sprintNumber").fill("2");
    await page.locator("#sprintDuration").fill("14");
    await page.locator("#sprintStartDate").fill("2026-08-15");
    await page.locator("#saveSprintBtn").click();
    await expect(page.locator("#gmToast")).toContainText('Sprint "Sprint 2" created');
    await page.locator("dialog[open] .dialog-close").last().click();

    async function createOrganizedCard(title: string, epicLabel?: string, sprintLabel?: string) {
      // All four cards below pile up in Backlog together, so this goes through the
      // toolbar button rather than double-clicking the lane (see addCardViaToolbar).
      await addCardViaToolbar(page, title);
      await fillRequiredCardFields(page);
      if (epicLabel || sprintLabel) {
        await ensureSectionExpanded(page, "organization");
        if (epicLabel) await page.locator("#cardEpic").selectOption({ label: epicLabel });
        if (sprintLabel) await page.locator("#cardSprint").selectOption({ label: sprintLabel });
      }
      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    }

    await createOrganizedCard("Add Apple Pay", "Checkout Revamp", "Sprint 1 (Checkout Revamp)");
    await createOrganizedCard("Fix tax rounding", "Checkout Revamp", "Sprint 1 (Checkout Revamp)");
    await createOrganizedCard("Add PayPal", "Checkout Revamp", "Sprint 2 (Checkout Revamp)");
    await createOrganizedCard("Unrelated housekeeping"); // no epic, no sprint

    await expect(page.locator(".card")).toHaveCount(4);

    // BUG: the Epic/Sprint filter dropdowns don't yet know an epic or sprint exists.
    // Creating one, from either Manage Epics/Manage Sprints (index.html:7846,
    // index.html:8030) or a card's own "+" buttons (index.html:8227, index.html:8339),
    // never calls updateEpicFilter()/updateSprintFilter() (index.html:4655,4670) - only a
    // full renderAll() does, and saving a card only calls the narrower renderLanes(). The
    // options this test needs are missing until something else forces a full re-render.
    await expect(page.locator("#filterEpic option", { hasText: "Checkout Revamp" })).toHaveCount(0);

    // Undo followed by Redo is the lightest real control that happens to call renderAll()
    // (index.html:4126,4144) - it's used here purely to force the missing refresh, not
    // because undoing/redoing is part of this session.
    await page.locator("#undoBtn").click();
    await page.locator("#redoBtn").click();
    await expect(page.locator(".card")).toHaveCount(4); // confirms the undo/redo round-trip was a no-op
    await expect(page.locator("#filterEpic option", { hasText: "Checkout Revamp" })).toHaveCount(1);

    await page.locator("#filterEpic").selectOption({ label: "Checkout Revamp" });
    await expect(page.locator(".card")).toHaveCount(3);

    await page.locator("#filterEpic").selectOption({ label: "All Epics" });
    await page.locator("#filterSprint").selectOption({ label: "Sprint 1 (Checkout Revamp)" });
    await expect(page.locator(".card")).toHaveCount(2);

    await page.locator("#filterSprint").selectOption({ label: "Sprint 2 (Checkout Revamp)" });
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card")).toContainText("Add PayPal");
  });
});

test.describe("Flow: team capacity", () => {
  test("Team Capacity reflects the effort actually assigned to each person", async ({ page }) => {
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    async function createAssignedStartedCard(title: string, person: string, capacity: string, effort: string) {
      await addCard(page, "backlog", title);
      await fillRequiredCardFields(page);
      await openPlanningSection(page);

      queuePrompt(person, capacity);
      await page.locator("#addAssigneeBtn").click();
      await page.locator("#cardAssignee").selectOption({ label: person });
      await page.locator(`.effort-chip[data-value="${effort}"]`).click();
      await page.locator("#cardDueDate").fill("2026-09-01");
      await page.locator("#cardRisk").selectOption("Low");
      await page.locator("#cardPriority").selectOption("Medium");

      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

      // Starting moves the card into an active lane, which is what counts toward load.
      // Waiting for it to actually leave Backlog (not just clicking Start) matters because
      // the next card is opened by double-clicking Backlog's body - if this card is still
      // rendered there, its bounding box can steal that click instead of the empty lane.
      await laneCards(page, "backlog").filter({ hasText: title }).locator('.card-action-btn[data-action="start"]').click();
      await expect(laneCards(page, "backlog").filter({ hasText: title })).toHaveCount(0);
    }

    await createAssignedStartedCard("Add Apple Pay", "Alice", "5", "3");
    await createAssignedStartedCard("Fix tax rounding", "Bob", "10", "8");

    await page.locator("#capacityBtn").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog.locator(".dialog-title")).toContainText("Team Capacity");

    const aliceRow = dialog.locator("tr", { hasText: "Alice" });
    await expect(aliceRow.locator("td").nth(1)).toHaveText("3.0"); // current load
    await expect(aliceRow.locator("td").nth(2)).toHaveText("5"); // max capacity

    const bobRow = dialog.locator("tr", { hasText: "Bob" });
    await expect(bobRow.locator("td").nth(1)).toHaveText("8.0");
    await expect(bobRow.locator("td").nth(2)).toHaveText("10");
  });
});

test.describe("Flow: multi-lane workflow", () => {
  test("a custom lane's WIP badge flags an over-limit state once two cards land in it", async ({ page }) => {
    // A 6th lane sits off the right edge of the default viewport. Card drag-and-drop is
    // simulated via real mouse movement, and dragging across a scroll boundary loses
    // the drop target midway - a wide viewport keeps every lane on screen at once.
    await page.setViewportSize({ width: 2400, height: 900 });
    await openBoard(page);
    await createCard(page, "backlog", "First ticket");
    await createCard(page, "backlog", "Second ticket");

    await page.locator("#addLaneBtn").click();
    await page.locator("#newLaneName").fill("QA Review");
    await page.locator("#newLaneWip").fill("1");
    await page.locator("#createLaneBtn").click();
    await expect(page.locator('.lane[data-lane-id="qa-review"]')).toBeVisible();

    const qaBody = page.locator('.lane[data-lane-id="qa-review"] .lane-body');

    await laneCards(page, "backlog").first().dragTo(qaBody);
    await expect(laneCards(page, "qa-review")).toHaveCount(1);

    await laneCards(page, "backlog").first().dragTo(qaBody);
    await expect(laneCards(page, "qa-review")).toHaveCount(2);
    await expect(laneCards(page, "backlog")).toHaveCount(0);

    const badge = page.locator('.lane[data-lane-id="qa-review"] .wip-badge');
    await expect(badge).toHaveClass(/over/);
    await expect(badge).toContainText("2/1");
  });
});

test.describe("Flow: backup and restore", () => {
  test("Export JSON produces a real backup, and Reset to Defaults truly empties the board", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Migrate billing service");
    await createCard(page, "backlog", "Retire legacy auth endpoint");

    await page.locator("#hamburgerBtn").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator('.hamburger-item[data-action="export"]').click();
    const download = await downloadPromise;
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const exported = JSON.parse(fs.readFileSync(filePath as string, "utf-8"));
    const titles = (exported.cards as Array<{ title: string }>).map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["Migrate billing service", "Retire legacy auth endpoint"]));

    page.on("dialog", (d) => d.accept());
    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="reset"]').click();
    await expect(page.locator(".card")).toHaveCount(0);
    await expect(page.locator(".lane")).toHaveCount(5);

    // BUG: there is no reachable UI path to bring that export back in.
    //
    // "Load Profile" and "Restore Backup" (index.html:8820-8821 wire to loadProfileFile()
    // at index.html:6957 and restoreFromBackup() at index.html:7496) both hard-require the
    // File System Access API - a showOpenFilePicker() call or a folder handle obtained from
    // showDirectoryPicker(). helpers.ts openBoard() deliberately deletes those APIs before
    // every test, which is also what a real visitor gets on Firefox or mobile (see the
    // openBoard() docstring), so for a large share of real users these two menu items can
    // only ever show an error, never actually restore anything.
    //
    // importProfile() (index.html:7375) is the one function that reads a plain
    // <input type="file"> and would work everywhere - but it is never called from anywhere
    // in the file. It has no button, no hamburger-item, nothing. "Export JSON" therefore has
    // no working "Import JSON" counterpart for anyone without folder access. What SHOULD
    // happen: a hamburger item wired to importProfile() (or a fallback to it when the
    // pickers are unavailable), so an exported board can always be brought back in.
    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="loadProfile"]').click();
    await expect(page.locator("#miniConsole")).toContainText("File System Access API not supported");

    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="restoreBackup"]').click();
    await expect(page.locator("#miniConsole")).toContainText("Please set save folder first");
  });
});

test.describe("Flow: metrics after real work", () => {
  test("Flow Metrics reports throughput and a WIP count consistent with the board", async ({ page }) => {
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    async function createStartedCard(title: string, effort: string) {
      await addCard(page, "backlog", title);
      await fillRequiredCardFields(page);
      await openPlanningSection(page);
      await page.locator(`.effort-chip[data-value="${effort}"]`).click();
      await page.locator("#cardDueDate").fill("2026-09-15");
      await page.locator("#cardRisk").selectOption("Low");
      await page.locator("#cardPriority").selectOption("Low");

      const assignee = page.locator("#cardAssignee");
      const before = await assignee.locator("option").count();
      if (before <= 1) {
        queuePrompt("Metrics Person", "10");
        await page.locator("#addAssigneeBtn").click();
        await expect(assignee.locator("option")).not.toHaveCount(before, { timeout: 10000 });
      }
      const optionCount = await assignee.locator("option").count();
      await assignee.selectOption({ index: optionCount - 1 });

      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

      // See the identical comment in the team-capacity flow above: waiting for the card to
      // actually leave Backlog avoids the next card's dblclick landing on this one instead.
      await laneCards(page, "backlog").filter({ hasText: title }).locator('.card-action-btn[data-action="start"]').click();
      await expect(laneCards(page, "backlog").filter({ hasText: title })).toHaveCount(0);
    }

    await createStartedCard("Ticket A", "3");
    await createStartedCard("Ticket B", "5");
    await createStartedCard("Ticket C", "8");

    // Carry Ticket A all the way through to Done so throughput has something to report.
    await laneCards(page, "progress").filter({ hasText: "Ticket A" }).locator(".card-title").dblclick();
    await ensureSectionExpanded(page, "quality");
    await page.locator("#cardAc").fill("Given valid input, when submitted, then it is accepted");
    await page.locator("#cardDod").fill("Reviewed and deployed");
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await laneCards(page, "progress").filter({ hasText: "Ticket A" }).locator('.card-action-btn[data-action="done"]').click();

    await expect(laneCards(page, "done")).toHaveCount(1);
    await expect(laneCards(page, "progress")).toHaveCount(2);

    await page.locator("#metricsBtn").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog.locator(".dialog-title")).toContainText("Flow Metrics Dashboard");

    // The dashboard is a flat grid of "<label div><value div>" pairs with no ids, so read
    // the value that immediately follows an exact label match rather than fight locators.
    const metricValue = (label: string) =>
      dialog.evaluate((root, wantedLabel) => {
        const labelEl = Array.from(root.querySelectorAll("div")).find(
          (d) => d.children.length === 0 && d.textContent?.trim() === wantedLabel,
        );
        return labelEl?.nextElementSibling?.textContent?.trim() ?? null;
      }, label);

    const throughput7d = Number(await metricValue("Throughput (7d)"));
    expect(throughput7d).toBeGreaterThanOrEqual(1);

    const wipItems = Number(await metricValue("WIP Items"));
    expect(wipItems).toBe(2); // Ticket B + Ticket C are still active; Ticket A is Done

    const wipInProgress = Number(await metricValue("WIP In Progress"));
    expect(wipInProgress).toBe(2);
  });
});

test.describe("Flow: preferences round-trip", () => {
  test("theme, lane width, WIP display and identity survive a logout/login cycle", async ({ page }) => {
    await openBoard(page);

    await page.locator("#prefsBtn").click();
    await page.locator("#prefTheme").selectOption("violet");
    await page.locator("#prefLaneMin").fill("420");
    await page.locator("#prefWipDisplay").selectOption("none");
    await page.locator("#prefUserColor").selectOption({ index: 4 }); // Purple
    await page.locator("#prefUserShape").selectOption("diamond");
    await page.locator("#prefsSaveBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Preferences and user identity saved");

    const laneMinBefore = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--lane-min-width").trim(),
    );
    expect(laneMinBefore).toBe("420px");

    // Reload never auto-resumes the board (StartupModal.show() always runs) - log out
    // properly so the user record is saved and marked logged-out before we come back.
    await page.locator("#logoutBtn").click();
    await page.locator("#saveExitConfirmBtn").click();

    await expect(page.locator("#startupModal")).toBeVisible({ timeout: 15000 });
    await page.locator("#startupContinueBtn").click();
    await expect(page.locator("#startupUserSelectionView")).toBeVisible();
    await page.locator("#startupUserDropdown").selectOption({ index: 1 });
    await page.locator("#startupUserContinueBtn").click();
    await expect(page.locator("#startupModal")).toBeHidden({ timeout: 15000 });
    // handleUserSelection() (index.html:9900) closes the modal and only THEN awaits
    // initApp() - which is what actually calls applyPrefs() and sets the CSS variables
    // this test is about. #lanes itself is static markup, always "visible" even empty, so
    // waiting for it isn't enough; waiting for its rendered lane children is the signal
    // that initApp()'s renderAll() (and therefore the earlier applyPrefs()) has run.
    await expect(page.locator(".lane")).toHaveCount(5, { timeout: 15000 });

    const laneMinAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--lane-min-width").trim(),
    );
    expect(laneMinAfter).toBe("420px");

    // WIP display: none hides the "x/y" text on every lane's badge.
    await expect(page.locator('.lane[data-lane-id="backlog"] .wip-badge')).not.toContainText("/");

    await page.locator("#prefsBtn").click();
    await expect(page.locator("#prefTheme")).toHaveValue("violet");
    await expect(page.locator("#prefWipDisplay")).toHaveValue("none");
    await expect(page.locator("#prefLaneMin")).toHaveValue("420");
    await expect(page.locator("#prefUserShape")).toHaveValue("diamond");
  });
});

test.describe("Flow: undo and redo across real edits", () => {
  test("undo twice then redo once lands on the expected board state at each step", async ({ page }) => {
    await openBoard(page);

    // Action 1: add a lane.
    await page.locator("#addLaneBtn").click();
    await page.locator("#newLaneName").fill("Testing");
    await page.locator("#createLaneBtn").click();
    await expect(page.locator(".lane")).toHaveCount(6);

    // Action 2: rename a lane.
    const readyTitle = page.locator('.lane-title[data-lane-id="ready"]');
    await readyTitle.click();
    await readyTitle.fill("Queued");
    await readyTitle.blur();
    await expect(readyTitle).toHaveText("Queued");

    // Action 3: set a WIP limit on Backlog.
    await page.locator('.wip-editable[data-lane-id="backlog"]').click();
    await page.locator("#wipLimitInput").fill("3");
    await page.locator("#saveWipBtn").click();
    await expect(page.locator('.lane[data-lane-id="backlog"] .wip-badge')).toContainText("/3");

    // Undo #1: reverts the WIP limit only.
    await page.locator("#undoBtn").click();
    await expect(page.locator(".lane")).toHaveCount(6);
    await expect(page.locator('.lane-title[data-lane-id="ready"]')).toHaveText("Queued");
    await expect(page.locator('.lane[data-lane-id="backlog"] .wip-badge')).not.toContainText("/3");

    // Undo #2: reverts the rename too, back to "Ready".
    await page.locator("#undoBtn").click();
    await expect(page.locator(".lane")).toHaveCount(6);
    await expect(page.locator('.lane-title[data-lane-id="ready"]')).toHaveText("Ready");

    // Redo #1: reapplies the rename, nothing else.
    await page.locator("#redoBtn").click();
    await expect(page.locator('.lane-title[data-lane-id="ready"]')).toHaveText("Queued");
    await expect(page.locator('.lane[data-lane-id="backlog"] .wip-badge')).not.toContainText("/3");
    await expect(page.locator(".lane")).toHaveCount(6);
  });
});
