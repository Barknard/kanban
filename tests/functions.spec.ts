import { expect, test, type Page } from "@playwright/test";
import { addCard, createCard, fillRequiredCardFields, laneCards, openBoard } from "./helpers";

/**
 * Exhaustive per-control coverage. board.spec.ts already owns: boot, add/rename/delete
 * lane, WIP limit + display pref, card required-fields, start-gate, aria-labels,
 * attachments (add + persist), search filter, Mine Only, chip keyboard operability,
 * Ctrl+Z guard, quota honesty, corrupt-profile tolerance, PWA manifest, third-party
 * requests. Everything here is deliberately something board.spec.ts does not touch.
 *
 * Whole believable sessions (create -> work -> verify) live in flows.spec.ts instead of
 * here; this file walks the toolbar, filter bar, card dialog, lane controls and hamburger
 * menu control-by-control.
 */

/** See flows.spec.ts for why this exists: one persistent dialog listener per test, fed by a queue. */
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
 * (The two tests that deliberately exercise that toggle behaviour click the header
 * directly rather than going through this.)
 */
async function ensureSectionExpanded(page: Page, section: string) {
  const content = page.locator(`#content-${section}`);
  const isCollapsed = await content.evaluate((el) => el.classList.contains("collapsed"));
  if (isCollapsed) {
    await page.locator(`.dialog-section-header[data-section="${section}"]`).click();
  }
}

async function openPlanningSection(page: Page) {
  await ensureSectionExpanded(page, "planning");
}

/**
 * Opens a new card via the toolbar button instead of double-clicking a lane's body.
 *
 * addCard() (helpers.ts) double-clicks the CENTRE of the lane body's bounding box, which
 * is exactly right for the first card in an empty lane. Once several cards already sit in
 * that lane the centre point can land on one of them instead of the empty background, so
 * any test building up more than a couple of cards in the same lane without moving them
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

test.describe("Toolbar", () => {
  test("New Card opens a blank card defaulted to Backlog, and Escape discards it", async ({ page }) => {
    await openBoard(page);
    await page.locator("#addCardBtn").click();
    await expect(page.locator("#cardDialog")).toBeVisible();
    await expect(page.locator("#cardTitle")).toHaveValue("New Card");

    await page.keyboard.press("Escape");
    await expect(page.locator("#cardDialog")).toBeHidden();
    await expect(laneCards(page, "backlog")).toHaveCount(0); // the unsaved temp card is cleaned up
  });

  test("changing Card Type auto-fills empty essential fields, but never overwrites text already typed", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Login button unresponsive");

    await page.locator("#cardType").selectOption("Bug");
    await expect(page.locator("#cardProblem")).toHaveValue(/Steps to reproduce/);
    await expect(page.locator("#cardOutcome")).toHaveValue(/Fix will restore/);
    await expect(page.locator("#cardImpact")).toHaveValue(/no longer experience/);

    await page.locator("#cardOutcome").fill("Custom outcome the tester wrote by hand");
    await page.locator("#cardType").selectOption("Chore");
    await expect(page.locator("#cardOutcome")).toHaveValue("Custom outcome the tester wrote by hand");
  });

  test("Undo and Redo report when there is nothing to do", async ({ page }) => {
    await openBoard(page);
    await page.locator("#undoBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Nothing to undo");
    await page.locator("#redoBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Nothing to redo");
  });

  test("Flow Metrics on an empty board reports honest zeros rather than blanks or stale data", async ({ page }) => {
    await openBoard(page);
    await page.locator("#metricsBtn").click();
    const dialog = page.locator("dialog[open]").last();
    await expect(dialog.locator(".dialog-title")).toContainText("Flow Metrics Dashboard");

    const metricValue = (label: string) =>
      dialog.evaluate((root, wantedLabel) => {
        const labelEl = Array.from(root.querySelectorAll("div")).find(
          (d) => d.children.length === 0 && d.textContent?.trim() === wantedLabel,
        );
        return labelEl?.nextElementSibling?.textContent?.trim() ?? null;
      }, label);

    expect(await metricValue("WIP Items")).toBe("0");
    expect(await metricValue("Throughput (7d)")).toBe("0");
  });

  test("Team Capacity dialog refuses to open against an empty roster and says why", async ({ page }) => {
    await openBoard(page);
    // A freshly created profile is never actually empty - createProfile() (index.html:3122)
    // seeds one assignee from the founder's own startup name. Reset to Defaults explicitly
    // clears STATE.profile.assignees (index.html:7469), which is the only way to reach the
    // empty-roster branch of openCapacityDialog() (index.html:5628) through the UI.
    page.on("dialog", (d) => d.accept());
    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="reset"]').click();
    await expect(page.locator("#gmToast")).toContainText("Reset to defaults");

    await page.locator("#capacityBtn").click();
    await expect(page.locator("#gmToast")).toContainText("No developers found");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });

  test("the Team Capacity display opens a dialog to choose which lanes count toward it", async ({ page }) => {
    await openBoard(page);
    await page.locator("#teamCapacityDisplay").click();
    const dialog = page.locator("dialog[open]").last();
    await expect(dialog.locator(".dialog-title")).toContainText("Configure Team Capacity");

    // Done and Backlog never count toward capacity, and their checkboxes make that explicit.
    await expect(dialog.locator('input.capacity-lane-checkbox[value="done"]')).toBeDisabled();
    await expect(dialog.locator('input.capacity-lane-checkbox[value="backlog"]')).toBeDisabled();

    const reviewCheckbox = dialog.locator('input.capacity-lane-checkbox[value="review"]');
    await expect(reviewCheckbox).toBeChecked();
    await reviewCheckbox.uncheck();
    await dialog.locator("#saveCapacityLanesBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Capacity lanes updated");
  });

  test("the Dark Mode checkbox and theme presets are independent, and a preset previews its colours immediately", async ({ page }) => {
    await openBoard(page);
    await page.locator("#prefsBtn").click();
    await expect(page.locator("#prefDarkMode")).toBeChecked();

    await page.locator("#prefTheme").selectOption("slate");
    await expect(page.locator("#prefPrimary")).toHaveValue("#64748b");
    await expect(page.locator("#prefAccent")).toHaveValue("#f43f5e");

    await page.locator("#prefsApplyBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Preferences applied");
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--gm-primary").trim(),
    );
    expect(primary).toBe("#64748b");
  });

  test("Make Default and Reset Defaults manage a template for future profiles, not the current board", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Should survive both buttons untouched");

    await page.locator("#prefsBtn").click();
    await page.locator("#makeDefaultBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Default preferences saved");
    await expect(page.locator(".card")).toHaveCount(1);

    page.on("dialog", (d) => d.accept());
    await page.locator("#resetDefaultsBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Default preferences reset");
    await expect(page.locator(".card")).toHaveCount(1); // this button never touches the board
  });
});

test.describe("Hamburger menu", () => {
  test("New Profile wipes the board back to an untouched default", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Soon to be gone");

    page.on("dialog", (d) => d.accept());
    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="new"]').click();

    await expect(page.locator("#gmToast")).toContainText("New profile created");
    await expect(page.locator(".card")).toHaveCount(0);
    await expect(page.locator(".lane")).toHaveCount(5);
  });

  test("Save As and Set Save Folder both report the missing File System Access API", async ({ page }) => {
    await openBoard(page);
    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="saveAs"]').click();
    await expect(page.locator("#miniConsole")).toContainText("File System Access API not supported");

    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="setFolder"]').click();
    await expect(page.locator("#miniConsole")).toContainText("File System Access API not supported");
  });
});

test.describe("Filter bar", () => {
  test("the Status filter narrows the board to a single lane's cards", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Stays in backlog");
    await createCard(page, "ready", "Sits in ready");
    await expect(page.locator(".card")).toHaveCount(2);

    await page.locator("#filterStatus").selectOption({ label: "Ready" });
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card")).toContainText("Sits in ready");
  });

  test("the due-date range filter narrows cards to a from/to window", async ({ page }) => {
    await openBoard(page);

    async function createCardWithDue(title: string, due: string) {
      // All three cards accumulate in Backlog together - see addCardViaToolbar.
      await addCardViaToolbar(page, title);
      await fillRequiredCardFields(page);
      await openPlanningSection(page);
      await page.locator("#cardDueDate").fill(due);
      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    }

    await createCardWithDue("Due early", "2026-01-10");
    await createCardWithDue("Due mid", "2026-06-15");
    await createCardWithDue("Due late", "2026-12-20");

    await page.locator("#filterDueFrom").fill("2026-05-01");
    await page.locator("#filterDueTo").fill("2026-07-01");
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".card")).toContainText("Due mid");
  });

  test("the Assignee filter's '+ Add New Assignee' option adds to the roster and resets itself", async ({ page }) => {
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    queuePrompt("Filter Person", "6");
    await page.locator("#filterAssignee").selectOption("__ADD_NEW_ASSIGNEE__");

    await expect(page.locator("#filterAssignee option", { hasText: "Filter Person" })).toHaveCount(1, { timeout: 10000 });
    // It resets to "All Assignees" rather than leaving the sentinel option selected.
    await expect(page.locator("#filterAssignee")).toHaveValue("");
  });
});

test.describe("Card dialog: sections", () => {
  test("the Essential section refuses to collapse until every mandatory field is filled", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Gate check");

    // This test is specifically about the toggle/guard behaviour, so it clicks the header
    // directly (both clicks below are meant to attempt a collapse) rather than going
    // through ensureSectionExpanded(), which would refuse to click an already-expanded
    // section - exactly the state Essential starts in.
    const essentialHeader = page.locator('.dialog-section-header[data-section="essential"]');
    await essentialHeader.click();
    await expect(page.locator("#gmToast")).toContainText("cannot be collapsed");
    await expect(page.locator("#content-essential")).not.toHaveClass(/collapsed/);

    await fillRequiredCardFields(page);
    await essentialHeader.click();
    await expect(page.locator("#content-essential")).toHaveClass(/collapsed/);
  });

  test("clicking a section header expands and re-collapses its content", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Section toggling");

    const header = page.locator('.dialog-section-header[data-section="story"]');
    const content = page.locator("#content-story");
    await expect(content).toHaveClass(/collapsed/);
    await header.click();
    await expect(content).not.toHaveClass(/collapsed/);
    await header.click();
    await expect(content).toHaveClass(/collapsed/);
  });

  test("the (x) button saves the card rather than discarding it, exactly like the Save button", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Half filled");

    // Required fields are intentionally left blank.
    await page.locator("#cardDialog .dialog-close").click();
    // NOTE: index.html:1905 wires the (x) button to click #cardSaveBtn directly, so it is
    // not a "cancel" - an incomplete card blocks it exactly the way Save does.
    await expect(page.locator("#cardDialog")).toBeVisible();

    await fillRequiredCardFields(page);
    await page.locator("#cardDialog .dialog-close").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#gmToast")).toContainText("Card created");
  });

  test("the card colour picker recolours the dialog border immediately", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Colour me");

    await page.locator("#cardColor").selectOption("#51cf66"); // Green
    const borderColor = await page.locator("#cardDialog").evaluate((el) => (el as HTMLElement).style.borderColor);
    expect(borderColor).toBe("rgb(81, 207, 102)");
  });

  test("effort chips are single-select and drive the hidden effort field", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Pick an effort");
    await openPlanningSection(page);

    await page.locator('.effort-chip[data-value="3"]').click();
    await expect(page.locator('.effort-chip[data-value="3"]')).toHaveClass(/selected/);
    await expect(page.locator("#cardEffort")).toHaveValue("3");

    await page.locator('.effort-chip[data-value="8"]').click();
    await expect(page.locator('.effort-chip[data-value="8"]')).toHaveClass(/selected/);
    await expect(page.locator('.effort-chip[data-value="3"]')).not.toHaveClass(/selected/);
    await expect(page.locator("#cardEffort")).toHaveValue("8");
  });

  test("the in-dialog Block toggle picks a default reason, and clearing the reason unblocks", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Toggle block from the dialog");
    await laneCards(page, "backlog").first().locator(".card-title").dblclick();
    await ensureSectionExpanded(page, "links");

    await expect(page.locator("#cardBlockToggleBtn")).toHaveText("🔓 Unblocked");
    await page.locator("#cardBlockToggleBtn").click();
    await expect(page.locator("#cardBlockToggleBtn")).toHaveText("🔒 Blocked");
    await expect(page.locator("#cardBlockReason")).toHaveValue("External dependency");

    await page.locator("#cardBlockReason").selectOption("");
    await expect(page.locator("#cardBlockToggleBtn")).toHaveText("🔓 Unblocked");

    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(laneCards(page, "backlog").first()).not.toHaveClass(/card-blocked/);
  });

  test("moving a card out of Backlog via the Status dropdown requires Acceptance Criteria and a Tester", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Gate on status change");
    await fillRequiredCardFields(page);

    await page.locator("#cardStatus").selectOption({ label: "Ready" });
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeVisible();
    await expect(page.locator("#miniConsole")).toContainText("Cannot move from Backlog");

    await ensureSectionExpanded(page, "quality");
    await page.locator("#cardAc").fill("Given valid input, when submitted, then it is accepted");

    await ensureSectionExpanded(page, "team");
    await page.locator("#addTesterBtn").click();
    const testerDialog = page.locator("dialog[open]").last();
    await testerDialog.locator("#newTesterName").fill("QA Tester");
    await testerDialog.locator("#createTesterBtn").click();
    await expect(page.locator("#cardTester")).not.toHaveValue("");

    // Adding a tester must not disturb the Developer already chosen. Both the tester and
    // assignee paths repopulate that dropdown because they share one roster, and both
    // used to pass '' — clearing a REQUIRED field, so the next Save failed with a
    // validation error the user did not cause.
    await expect(page.locator("#cardDeveloper")).not.toHaveValue("");

    await page.locator("#cardStatus").selectOption({ label: "Ready" });
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(laneCards(page, "ready")).toHaveCount(1);
  });

  test("the Epic and Sprint '+' buttons inside the card dialog create and auto-select in one step", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Organize me");
    await ensureSectionExpanded(page, "organization");

    await page.locator("#addEpicBtn").click();
    const epicDialog = page.locator("dialog[open]").last();
    await epicDialog.locator("#newEpicName").fill("Onboarding");
    await epicDialog.locator("#newEpicCode").fill("ONB");
    await epicDialog.locator("#createEpicBtn").click();
    await expect(page.locator("#cardEpic")).not.toHaveValue("");
    await expect(page.locator("#cardEpic option:checked")).toHaveText("Onboarding");

    await page.locator("#addSprintBtn").click();
    const sprintDialog = page.locator("dialog[open]").last();
    await sprintDialog.locator("#createSprintBtn").click(); // every field already has a usable default
    await expect(page.locator("#cardSprint")).not.toHaveValue("");
    await expect(page.locator("#cardSprint option:checked")).toContainText("Sprint 1");
  });

  test("a dependency checked on one card is still checked after saving and reopening it", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Base infrastructure");
    await createCard(page, "backlog", "Feature built on top");

    const dependentTitle = "Feature built on top";
    await laneCards(page, "backlog").filter({ hasText: dependentTitle }).locator(".card-title").dblclick();
    await ensureSectionExpanded(page, "links");
    await page
      .locator("#cardDependenciesList label", { hasText: "Base infrastructure" })
      .locator('input[type="checkbox"]')
      .check();
    await page.locator("#cardSaveBtn").click();
    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });

    await laneCards(page, "backlog").filter({ hasText: dependentTitle }).locator(".card-title").dblclick();
    await ensureSectionExpanded(page, "links");
    await expect(
      page.locator("#cardDependenciesList label", { hasText: "Base infrastructure" }).locator('input[type="checkbox"]'),
    ).toBeChecked();
  });

  test("Duplicate creates an independent '(copy)' and closes the dialog", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Original ticket");
    await laneCards(page, "backlog").first().locator(".card-title").dblclick();
    await page.locator("#cardDuplicateBtn").click();

    await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#gmToast")).toContainText("Card duplicated");
    await expect(laneCards(page, "backlog")).toHaveCount(2);
    await expect(laneCards(page, "backlog").filter({ hasText: "Original ticket (copy)" })).toHaveCount(1);
  });

  test("the card collapse toggle switches between a brief preview and the full Problem/Outcome/Impact text", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "Collapsible card");
    const card = laneCards(page, "backlog").first();

    await expect(card.locator(".card-description-brief")).toBeVisible();
    await card.locator(".card-collapse").click();
    await expect(card.locator(".card-description-full")).toContainText("Problem:");
    await expect(card.locator(".card-description-full")).toContainText("Outcome:");

    await card.locator(".card-collapse").click();
    await expect(card.locator(".card-description-brief")).toBeVisible();
  });

  test("removing an attachment takes it out of the list immediately", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Attach then remove");
    await fillRequiredCardFields(page);
    await page.locator("#cardAttachments").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("some attached content"),
    });
    await expect(page.locator("#cardAttachmentsList")).toContainText("notes.txt");

    await page.locator(".attachment-remove").click();
    await expect(page.locator("#cardAttachmentsList")).not.toContainText("notes.txt");
  });
});

test.describe("Help", () => {
  test("Help & Documentation lists every field category, and a '?' icon shows a real tooltip", async ({ page }) => {
    await openBoard(page);
    await page.locator("#helpBtn").click();
    const dialog = page.locator("dialog[open]").last();
    await expect(dialog.locator(".dialog-title")).toContainText("Help & Documentation");
    for (const heading of ["Card Fields", "Epic & Sprint", "Team Members", "Board Organization", "Quality Assurance"]) {
      await expect(dialog).toContainText(heading);
    }
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    await addCard(page, "backlog", "Field help");
    const helpIcon = page.locator('label.form-label', { hasText: "Problem" }).locator(".help-icon");
    await helpIcon.click();
    const tooltip = page.locator(".help-tooltip");
    await expect(tooltip.locator(".help-tooltip-title")).toHaveText("Description");
    await expect(tooltip).toContainText("Extra details about what needs to be done and why");
  });

  test("BUG: Help still documents Bug-Reproduced/Steps/Environment QA fields the card dialog no longer has", async ({ page }) => {
    await openBoard(page);
    await addCard(page, "backlog", "Missing QA fields");
    await ensureSectionExpanded(page, "quality");

    // The Quality section really only has these three controls:
    await expect(page.locator("#cardAc")).toHaveCount(1);
    await expect(page.locator("#cardDod")).toHaveCount(1);
    await expect(page.locator("#cardTestingPlan")).toHaveCount(1);
    // ...none of the fields FIELD_HELP_MAP (index.html:2695-2697) still maps exist:
    await expect(page.locator("#cardReproduced")).toHaveCount(0);
    await expect(page.locator("#cardReproSteps")).toHaveCount(0);
    await expect(page.locator("#cardTestEnv")).toHaveCount(0);
    await page.keyboard.press("Escape"); // discard the incomplete card

    // Yet the Help dialog's "Quality Assurance" category (index.html:8723) is still built
    // from those three dead keys, describing fields a user will never find anywhere.
    await page.locator("#helpBtn").click();
    const dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("Quality Assurance");
    await expect(dialog).toContainText("Bug Reproduced"); // HELP_CONTENT['qa-reproduced'].title
  });
});

test.describe("Lane controls", () => {
  test("deleting a lane that still has cards is refused, with the card count in the message", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "review", "Still in review");

    await page.locator('.lane-btn[data-action="delete"][data-lane-id="review"]').click();
    await expect(page.locator("#gmToast")).toContainText('Cannot delete lane "Review" - it contains 1 card(s)');
    await expect(page.locator('.lane[data-lane-id="review"]')).toBeVisible();
  });

  test("dragging a lane's handle reorders the lanes", async ({ page }) => {
    // Five lanes at their default minimum width already overflow the default viewport.
    // Dragging across that scroll boundary loses the drop target midway through the
    // simulated mouse movement, so this keeps every lane on screen at once instead.
    await page.setViewportSize({ width: 2400, height: 900 });
    await openBoard(page);
    const laneIds = () => page.locator(".lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-lane-id")));
    expect(await laneIds()).toEqual(["backlog", "ready", "progress", "review", "done"]);

    await page
      .locator('.lane-drag-handle[data-lane-id="done"]')
      .dragTo(page.locator('.lane[data-lane-id="backlog"]'), { targetPosition: { x: 2, y: 10 } });

    const after = await laneIds();
    expect(after.indexOf("done")).toBeLessThan(after.indexOf("backlog"));
  });
});

test.describe("Manage Epics / Manage Sprints", () => {
  test("Manage Epics supports add, edit and delete", async ({ page }) => {
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    await page.locator("#epicsBtn").click();
    let dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("No epics yet");

    await dialog.locator("#addNewEpic").click();
    const createDialog = page.locator("dialog[open]").last();
    await createDialog.locator("#newEpicNameMenu").fill("Growth");
    await createDialog.locator("#newEpicCodeMenu").fill("GRO");
    await createDialog.locator("#createEpicBtnMenu").click();
    await expect(page.locator("#gmToast")).toContainText('Epic "Growth" created');

    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("Growth");

    queuePrompt("Growth Initiative", "GRW");
    await dialog.locator(".edit-epic").click();
    await expect(page.locator("#gmToast")).toContainText("Epic updated");

    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("Growth Initiative");

    await dialog.locator(".delete-epic").click(); // confirm() answered by the same queue (falls back to accept)
    await expect(page.locator("#gmToast")).toContainText("Epic deleted");
    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("No epics yet");
  });

  test("Manage Sprints supports add, edit and delete", async ({ page }) => {
    await openBoard(page);

    await page.locator("#epicsBtn").click();
    await page.locator("dialog[open]").last().locator("#addNewEpic").click();
    const epicCreate = page.locator("dialog[open]").last();
    await epicCreate.locator("#newEpicNameMenu").fill("Platform");
    await epicCreate.locator("#newEpicCodeMenu").fill("PLT");
    await epicCreate.locator("#createEpicBtnMenu").click();
    await page.locator("dialog[open] .dialog-close").last().click();

    await page.locator("#sprintsBtn").click();
    let dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("No sprints yet");

    await dialog.locator("#addNewSprint").click();
    const sprintCreate = page.locator("dialog[open]").last();
    await sprintCreate.locator("#sprintEpic").selectOption({ index: 0 });
    await sprintCreate.locator("#sprintName").fill("Sprint Zero");
    await sprintCreate.locator("#sprintNumber").fill("1");
    await sprintCreate.locator("#sprintDuration").fill("10");
    await sprintCreate.locator("#sprintStartDate").fill("2026-08-01");
    await sprintCreate.locator("#saveSprintBtn").click();
    await expect(page.locator("#gmToast")).toContainText('Sprint "Sprint Zero" created');

    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("Sprint Zero");

    await dialog.locator(".edit-sprint").click();
    const editDialog = page.locator("dialog[open]").last();
    await editDialog.locator("#editSprintName").fill("Sprint Zero Renamed");
    await editDialog.locator("#updateSprintBtn").click();
    await expect(page.locator("#gmToast")).toContainText("Sprint updated");

    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("Sprint Zero Renamed");

    page.on("dialog", (d) => d.accept());
    await dialog.locator(".delete-sprint").click();
    await expect(page.locator("#gmToast")).toContainText("Sprint deleted");
    dialog = page.locator("dialog[open]").last();
    await expect(dialog).toContainText("No sprints yet");
  });
});

test.describe("Identity and multi-user management", () => {
  test("identity: the creator is a real user, switching identity names a person, and renames follow onto cards", async ({ page }) => {
    const queuePrompt = makeDialogQueue(page);
    await openBoard(page);

    await test.step("the person who created the profile is a selectable user", async () => {
      // Profile creation collects a name, role, colour and shape, and now registers that
      // person as the profile's first user. It used to cache them in localStorage only,
      // leaving profile.users empty — so this dropdown had no options at all and the next
      // visit demanded a "Create New User" form from someone already introduced.
      await expect(page.locator("#meBtn option")).not.toHaveCount(0);
      await expect(page.locator("#meBtn")).toContainText("Test Board");
    });

    await test.step("add a second person to the same board", async () => {
      await page.locator("#logoutBtn").click();
      await page.locator("#saveExitConfirmBtn").click();
      await expect(page.locator("#startupModal")).toBeVisible({ timeout: 15000 });
      await page.locator("#startupContinueBtn").click();
      await expect(page.locator("#startupUserSelectionView")).toBeVisible();
      await page.locator("#startupCreateUserBtn").click();
      await page.locator("#startupNewUserFirstName").fill("Priya");
      await page.locator("#startupNewUserLastName").fill("Shah");
      await page.locator("#startupNewUserRole").selectOption({ index: 2 });
      await page.locator("#startupNewUserColor").selectOption({ index: 2 });
      await page.locator("#startupNewUserShape").selectOption("square");
      await page.locator("#startupCreateUserSubmitBtn").click();
      await expect(page.locator("#startupModal")).toBeHidden({ timeout: 15000 });
      await expect(page.locator(".lane")).toHaveCount(5, { timeout: 15000 });

      await expect(page.locator("#meBtn option")).toHaveCount(2);
    });

    await test.step("switching identity announces the person, not an internal id", async () => {
      const option = page.locator("#meBtn option", { hasText: "Priya Shah" });
      await page.locator("#meBtn").selectOption({ label: await option.innerText() });

      // setMe() used to put select.value — a `user_a1b2c3d4` id — straight into the toast.
      await expect(page.locator("#gmToast")).toContainText("Priya Shah");
      await expect(page.locator("#gmToast")).not.toContainText("user_");
    });

    await test.step("renaming yourself in the greeting updates cards that credit you", async () => {
      await createCard(page, "backlog", "Assigned work");
      await laneCards(page, "backlog").first().locator(".card-title").dblclick();
      await openPlanningSection(page);
      queuePrompt("Priya Shah", "10");
      await page.locator("#addAssigneeBtn").click();
      await page.locator("#cardAssignee").selectOption({ label: "Priya Shah" });
      await page.locator("#cardSaveBtn").click();
      await expect(page.locator("#cardDialog")).toBeHidden({ timeout: 10000 });
      await expect(page.locator(".card")).toContainText("Priya Shah");

      // The label reads "Welcome, <name>" and shows the signed-in person. Its edit used
      // to rename the PROFILE, which updateProfileLabel() then immediately painted over —
      // so the edit appeared to do nothing whatsoever.
      const label = page.locator("#profileNameDisplay");
      const before = (await label.innerText()).trim();
      await label.dblclick();
      await label.fill("Priya S. Shah");
      await label.blur();

      await expect(label).toHaveText("Priya S. Shah");
      expect(before).not.toBe("Priya S. Shah");
      // A rename has to follow onto the cards that name them, or the board credits a
      // person who no longer exists.
      await expect(page.locator(".card")).toContainText("Priya S. Shah");
    });
  });


  test("work done before touching any multi-user feature survives logging out", async ({ page }) => {
    // This was a real data-loss bug and is the reason routine saves now write through to
    // durable storage. Ordinary editing only ever called saveProfile(), which writes
    // localStorage; nothing reached StorageAdapter (the OPFS/IndexedDB store that startup
    // actually reads from) unless you had been through Preferences or the multi-user
    // flow. Log out — or simply reload — before that, and the board silently reverted to
    // the copy written when the profile was created.
    await openBoard(page);
    await createCard(page, "backlog", "Survives a logout");
    await expect(page.locator(".card")).toHaveCount(1);

    await page.locator("#logoutBtn").click();
    await page.locator("#saveExitConfirmBtn").click();
    await expect(page.locator("#startupModal")).toBeVisible({ timeout: 15000 });
    await page.locator("#startupContinueBtn").click();

    // The profile creator is a registered user now, so this offers them to sign back in
    // instead of demanding a "Create New User" form from someone already known. An
    // explicit logout deliberately does ask who you are — a plain reload does not (see
    // durability.spec.ts).
    await expect(page.locator("#startupUserSelectionView")).toBeVisible({ timeout: 15000 });
    await page.locator("#startupUserDropdown").selectOption({ index: 1 });
    await page.locator("#startupUserContinueBtn").click();

    await expect(page.locator("#startupModal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator(".lane")).toHaveCount(5, { timeout: 15000 });

    await expect(page.getByText("Survives a logout")).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Clear All Storage (destructive - run last)", () => {
  test("wipes everything after a double confirmation and returns to the startup screen", async ({ page }) => {
    await openBoard(page);
    await createCard(page, "backlog", "About to be obliterated");

    let dialogCount = 0;
    page.on("dialog", (d) => {
      dialogCount++;
      d.accept();
    });

    await page.locator("#hamburgerBtn").click();
    await page.locator('.hamburger-item[data-action="clearStorage"]').click();

    // clearAllStorage() (index.html:7397) asks for confirmation TWICE, then alert()s
    // success, then reloads - all three are native dialogs answered by the listener above.
    await expect(page.locator("#startupModal")).toBeVisible({ timeout: 15000 });
    expect(dialogCount).toBeGreaterThanOrEqual(2);

    // Storage is really gone: the create-profile path works exactly like a first run.
    await page.locator("#startupCreateBtn").click();
    await expect(page.locator("#startupCreateForm")).toBeVisible();
  });
});
