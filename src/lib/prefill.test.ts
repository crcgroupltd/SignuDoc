import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import {
  assertPrefillDefaults,
  formatPrefillDate,
  hasRequiredPrefill,
  prefillDefaults,
  PrefillError,
  resolvePrefillValues,
  withPrefillDefaults,
} from "./prefill.ts";
import {
  PREFILL_ASSIGNEE_ID,
  prefillFieldListSchema,
  type PrefillField,
} from "./schemas/template.ts";
import { stampPrefilledBoxes } from "./services/prefill-stamp.ts";
import type { StorageService } from "./services/storage.ts";

function box(overrides: Partial<PrefillField>): PrefillField {
  return {
    height: 0.05,
    id: "box-1",
    label: "Client name",
    page: 1,
    required: true,
    signerId: PREFILL_ASSIGNEE_ID,
    type: "text",
    width: 0.4,
    x: 0.1,
    y: 0.1,
    ...overrides,
  };
}

function rejectsFor(
  fields: PrefillField[],
  values: Record<string, string | boolean>,
  pattern: RegExp,
) {
  assert.throws(
    () => resolvePrefillValues(fields, values),
    (error: unknown) =>
      error instanceof PrefillError && pattern.test(error.message),
  );
}

test("prefill boxes can be any field type except signature and initials", () => {
  assert.equal(
    prefillFieldListSchema.safeParse([
      box({ id: "a", type: "text" }),
      box({ id: "b", type: "date" }),
      box({ id: "c", type: "checkbox" }),
      box({ id: "d", options: ["One", "Two"], type: "dropdown" }),
    ]).success,
    true,
  );
  assert.equal(
    prefillFieldListSchema.safeParse([box({ type: "signature" })]).success,
    false,
  );
  assert.equal(
    prefillFieldListSchema.safeParse([box({ type: "initials" })]).success,
    false,
  );
  // A box belonging to a signer is not a prefill box.
  assert.equal(
    prefillFieldListSchema.safeParse([box({ signerId: "role-1" })]).success,
    false,
  );
});

test("text and name values are trimmed, and a required box must be filled", () => {
  const filled = resolvePrefillValues(
    [box({ id: "a" }), box({ id: "b", required: false, type: "name" })],
    { a: "  Acme Corp  " },
  );

  assert.deepEqual(
    filled.map((entry) => entry.value),
    ["Acme Corp"],
  );
  rejectsFor([box({})], {}, /Fill in Client name/);
  rejectsFor([box({})], { "box-1": "   " }, /Fill in Client name/);
});

test("a value for a box the template does not have is refused", () => {
  rejectsFor([box({})], { "box-1": "x", other: "y" }, /template has changed/);
});

test("numbers must be numbers", () => {
  const field = box({ label: "Amount", type: "number" });

  assert.equal(
    resolvePrefillValues([field], { "box-1": "12,500.50" })[0]?.value,
    "12,500.50",
  );
  rejectsFor([field], { "box-1": "twelve" }, /Amount: Enter a number/);
});

test("dates are given as YYYY-MM-DD and written out in full", () => {
  const field = box({ label: "Start date", type: "date" });

  assert.equal(formatPrefillDate("2026-11-28"), "November 28, 2026");
  assert.equal(formatPrefillDate("2026-02-30"), null);
  assert.equal(
    resolvePrefillValues([field], { "box-1": "2026-01-05" })[0]?.value,
    "January 5, 2026",
  );
  rejectsFor([field], { "box-1": "28/11/2026" }, /needs a date/);
});

test("a dropdown value must be one of its choices", () => {
  const field = box({
    label: "Plan",
    options: ["Basic", "Pro"],
    type: "dropdown",
  });

  assert.equal(
    resolvePrefillValues([field], { "box-1": "Pro" })[0]?.value,
    "Pro",
  );
  rejectsFor([field], { "box-1": "Enterprise" }, /one of its choices/);
  rejectsFor([field], {}, /Choose Plan/);
});

test("checkboxes take true or false, and a required one must be ticked", () => {
  const field = box({ label: "Includes support", type: "checkbox" });

  assert.equal(
    resolvePrefillValues([field], { "box-1": true })[0]?.checked,
    true,
  );
  rejectsFor([field], { "box-1": false }, /Tick Includes support/);
  rejectsFor([field], { "box-1": "yes" }, /true or false/);
  assert.equal(
    resolvePrefillValues([{ ...field, required: false }], {})[0]?.checked,
    false,
  );
});

test("one radio button per group, and a required group needs one", () => {
  const yes = box({ groupId: "g", id: "yes", label: "Yes", type: "radio" });
  const no = box({ groupId: "g", id: "no", label: "No", type: "radio" });

  const filled = resolvePrefillValues([yes, no], { no: true, yes: false });

  assert.deepEqual(
    filled.map((entry) => [entry.field.id, entry.checked]),
    [
      ["yes", false],
      ["no", true],
    ],
  );
  rejectsFor([yes, no], { no: true, yes: true }, /only one of: Yes, No/);
  rejectsFor([yes, no], {}, /Choose one of: Yes, No/);
});

test("only required boxes without a default stop Send to many", () => {
  assert.equal(hasRequiredPrefill([box({ required: false })]), false);
  assert.equal(hasRequiredPrefill([box({ required: true })]), true);
  assert.equal(
    hasRequiredPrefill([box({ defaultValue: "Acme", required: true })]),
    false,
  );
  // A required radio group is covered when one button is the default.
  assert.equal(
    hasRequiredPrefill([
      box({ defaultValue: true, groupId: "g", id: "a", type: "radio" }),
      box({ groupId: "g", id: "b", type: "radio" }),
    ]),
    false,
  );
});

test("a box the sender leaves out keeps its default, and one they clear stays clear", () => {
  const fields = [
    box({ defaultValue: "Acme Corp", id: "client" }),
    box({ defaultValue: "Net 30", id: "terms", required: false }),
    box({ defaultValue: true, id: "tick", required: false, type: "checkbox" }),
  ];

  assert.deepEqual(prefillDefaults(fields), {
    client: "Acme Corp",
    terms: "Net 30",
    tick: true,
  });

  const merged = withPrefillDefaults(fields, { terms: "", tick: false });

  assert.deepEqual(
    resolvePrefillValues(fields, merged).map((entry) => [
      entry.field.id,
      entry.value ?? entry.checked,
    ]),
    [
      ["client", "Acme Corp"],
      ["tick", false],
    ],
  );
});

test("a default must be a value the box would accept", () => {
  assert.doesNotThrow(() =>
    assertPrefillDefaults([
      box({ id: "a" }),
      box({ defaultValue: "2026-12-01", id: "b", type: "date" }),
    ]),
  );
  assert.throws(
    () =>
      assertPrefillDefaults([
        box({ defaultValue: "soon", label: "Start", type: "date" }),
      ]),
    /Start needs a date/,
  );
  assert.throws(
    () =>
      assertPrefillDefaults([
        box({ defaultValue: "Gold", options: ["Basic"], type: "dropdown" }),
      ]),
    /one of its choices/,
  );
  assert.throws(
    () =>
      assertPrefillDefaults([
        box({ defaultValue: true, groupId: "g", id: "a", type: "radio" }),
        box({ defaultValue: true, groupId: "g", id: "b", type: "radio" }),
      ]),
    /only one of/,
  );
});

test("prefilled values are written into the document", async () => {
  const source = await PDFDocument.create();

  source.addPage([612, 792]);

  const sourceBytes = await source.save();
  const fields = [
    box({ id: "name" }),
    box({ id: "tick", type: "checkbox", y: 0.3, width: 0.05 }),
  ];
  const stamped = await stampPrefilledBoxes(
    sourceBytes,
    resolvePrefillValues(fields, { name: "Acme Corp", tick: true }),
    [{ heightPt: 792, pageNumber: 1, widthPt: 612 }],
    {} as StorageService,
  );

  assert.notDeepEqual(stamped, sourceBytes);

  const reloaded = await PDFDocument.load(stamped);

  assert.equal(reloaded.getPageCount(), 1);
  // The value is drawn with an embedded font, so the page now has one.
  const fonts = reloaded
    .getPage(0)
    .node.Resources()
    ?.lookupMaybe(
      (await import("pdf-lib")).PDFName.of("Font"),
      (await import("pdf-lib")).PDFDict,
    );

  assert.ok(fonts && fonts.keys().length > 0);
});

test("no prefilled boxes leaves the document as it was", async () => {
  const bytes = new Uint8Array([1, 2, 3]);

  assert.equal(
    await stampPrefilledBoxes(bytes, [], null, {} as StorageService),
    bytes,
  );
});
