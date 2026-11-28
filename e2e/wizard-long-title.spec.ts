import { expect, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

// 120 letters with no space: a title the form accepts, and one word the
// summary beside the Send button has to break.
const LONG_TITLE = "W".repeat(120);

for (const width of [1440, 1024]) {
  test(`a long unbroken title keeps Send envelope on screen at ${String(width)} px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ height: 850, width });
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("long.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill(LONG_TITLE);
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Wren Wide");
    await page.getByLabel("Signer 1 email").fill("wren.wide@example.com");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 1");
    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.6 },
    });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    const summary = page.getByTestId("send-summary");
    const sendButton = page.getByRole("button", { name: "Send envelope" });
    const summaryBox = await summary.boundingBox();
    const sendBox = await sendButton.boundingBox();

    // The summary beside the button wraps the whole title, and the button
    // stays inside the window.
    await expect(summary).toContainText(LONG_TITLE);
    expect(summaryBox!.x).toBeGreaterThanOrEqual(0);
    expect(summaryBox!.x + summaryBox!.width).toBeLessThanOrEqual(width);
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(width);
    expect(
      await summary.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await sendButton.click({ trial: true });
  });
}
