import { isNumberEntry, NUMBER_ENTRY_MESSAGE } from "./field-choices.ts";
import {
  MAX_PREFILL_TEXT_LENGTH,
  type PrefillField,
  type PrefillValues,
} from "./schemas/template.ts";

// The boxes a sender fills in when using a template. Each value is checked
// against its box the way a signer's answer is checked at signing, then
// turned into what the PDF stamping draws: text for text-like boxes, ticked
// or not for checkboxes and radio buttons.

export class PrefillError extends Error {
  readonly fieldId: string | null;

  constructor(message: string, fieldId: string | null = null) {
    super(message);
    this.name = "PrefillError";
    this.fieldId = fieldId;
  }
}

/** One box, filled in: what stamping draws on the page. */
export type PrefilledBox = {
  checked: boolean | null;
  field: PrefillField;
  value: string | null;
};

const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** What a box is called to the sender: its label, or its kind. */
export function prefillBoxName(field: PrefillField): string {
  const label = field.label?.trim();

  if (label) {
    return label;
  }

  switch (field.type) {
    case "checkbox":
      return "Checkbox";
    case "date":
      return "Date";
    case "dropdown":
      return "Dropdown";
    case "name":
      return "Name";
    case "number":
      return "Number";
    case "radio":
      return "Choice";
    default:
      return "Text";
  }
}

/**
 * "2026-11-28", as a date input gives it, written the way a signer's date
 * is: "November 28, 2026". Null for anything that is not a real date.
 */
export function formatPrefillDate(value: string): string | null {
  const match = DATE_VALUE.exec(value.trim());

  if (!match) {
    return null;
  }

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function readText(
  field: PrefillField,
  raw: string | boolean | undefined,
): string {
  if (raw === undefined) {
    return "";
  }

  if (typeof raw !== "string") {
    throw new PrefillError(
      `${prefillBoxName(field)} needs text, not a tick.`,
      field.id,
    );
  }

  return raw.trim();
}

function readTick(
  field: PrefillField,
  raw: string | boolean | undefined,
): boolean {
  if (raw === undefined) {
    return false;
  }

  if (typeof raw !== "boolean") {
    throw new PrefillError(
      `${prefillBoxName(field)} is ticked or not, so it takes true or false.`,
      field.id,
    );
  }

  return raw;
}

/**
 * Checks the sender's values against the template's prefill boxes and
 * returns the boxes that have something to draw. A value for a box the
 * template does not have is refused, so a mistyped id is not lost quietly.
 */
export function resolvePrefillValues(
  fields: readonly PrefillField[],
  values: PrefillValues,
): PrefilledBox[] {
  const byId = new Map(fields.map((field) => [field.id, field] as const));

  for (const id of Object.keys(values)) {
    if (!byId.has(id)) {
      throw new PrefillError(
        "This template has changed. Reload the page and fill it in again.",
        id,
      );
    }
  }

  const filled: PrefilledBox[] = [];
  const radioGroups = new Map<
    string,
    { labels: string[]; required: boolean; ticked: number; firstId: string }
  >();

  for (const field of fields) {
    const raw = values[field.id];
    const name = prefillBoxName(field);

    switch (field.type) {
      case "checkbox": {
        const ticked = readTick(field, raw);

        if (field.required && !ticked) {
          throw new PrefillError(`Tick ${name} before sending.`, field.id);
        }

        filled.push({ checked: ticked, field, value: null });
        break;
      }

      case "radio": {
        const ticked = readTick(field, raw);
        const groupId = field.groupId ?? field.id;
        const group = radioGroups.get(groupId) ?? {
          firstId: field.id,
          labels: [],
          required: field.required,
          ticked: 0,
        };

        group.labels.push(name);
        group.ticked += ticked ? 1 : 0;
        radioGroups.set(groupId, group);
        // Every button is drawn, ticked or not, as a signer's answer is.
        filled.push({ checked: ticked, field, value: null });
        break;
      }

      case "date": {
        const text = readText(field, raw);

        if (!text) {
          if (field.required) {
            throw new PrefillError(`Fill in ${name}.`, field.id);
          }
          break;
        }

        const formatted = formatPrefillDate(text);

        if (!formatted) {
          throw new PrefillError(
            `${name} needs a date, such as 2026-11-28.`,
            field.id,
          );
        }

        filled.push({ checked: null, field, value: formatted });
        break;
      }

      case "dropdown": {
        const text = readText(field, raw);

        if (!text) {
          if (field.required) {
            throw new PrefillError(`Choose ${name}.`, field.id);
          }
          break;
        }

        if (!(field.options ?? []).includes(text)) {
          throw new PrefillError(
            `${name} must be one of its choices.`,
            field.id,
          );
        }

        filled.push({ checked: null, field, value: text });
        break;
      }

      case "number": {
        const text = readText(field, raw);

        if (!text) {
          if (field.required) {
            throw new PrefillError(`Fill in ${name}.`, field.id);
          }
          break;
        }

        if (!isNumberEntry(text)) {
          throw new PrefillError(`${name}: ${NUMBER_ENTRY_MESSAGE}`, field.id);
        }

        filled.push({ checked: null, field, value: text });
        break;
      }

      default: {
        // Text and name boxes.
        const text = readText(field, raw);

        if (!text) {
          if (field.required) {
            throw new PrefillError(`Fill in ${name}.`, field.id);
          }
          break;
        }

        if (text.length > MAX_PREFILL_TEXT_LENGTH) {
          throw new PrefillError(`${name} is too long.`, field.id);
        }

        filled.push({ checked: null, field, value: text });
      }
    }
  }

  for (const group of radioGroups.values()) {
    const choices = group.labels.join(", ");

    if (group.ticked > 1) {
      throw new PrefillError(`Choose only one of: ${choices}.`, group.firstId);
    }

    if (group.required && group.ticked === 0) {
      throw new PrefillError(`Choose one of: ${choices}.`, group.firstId);
    }
  }

  return filled;
}

/** The values a template's boxes start with, by box id. */
export function prefillDefaults(
  fields: readonly PrefillField[],
): PrefillValues {
  const defaults: PrefillValues = {};

  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      defaults[field.id] = field.defaultValue;
    }
  }

  return defaults;
}

/**
 * The sender's values over the template's defaults: a box the sender gave
 * nothing for keeps its default. One they cleared stays clear.
 */
export function withPrefillDefaults(
  fields: readonly PrefillField[],
  values: PrefillValues,
): PrefillValues {
  return { ...prefillDefaults(fields), ...values };
}

/**
 * Checks the defaults saved with a template the way a sender's values are
 * checked, except that a box may be left without one.
 */
export function assertPrefillDefaults(fields: readonly PrefillField[]): void {
  resolvePrefillValues(
    fields.map((field) => ({ ...field, required: false })),
    prefillDefaults(fields),
  );
}

/**
 * Whether a template has a required prefill box with no default, which
 * the sender must fill in, so it cannot be sent to many at once.
 */
export function hasRequiredPrefill(fields: readonly PrefillField[]): boolean {
  try {
    resolvePrefillValues(fields, prefillDefaults(fields));
    return false;
  } catch (error) {
    if (error instanceof PrefillError) {
      return true;
    }

    throw error;
  }
}
