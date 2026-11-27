"use client";

import type { PrefillField, PrefillValues } from "@/lib/schemas/template";

// The "Fill in before sending" part of the use-template form: one input per
// prefill box, in reading order. What is entered is written into the
// document when the draft is made.

type PrefillInputsProps = {
  disabled: boolean;
  /** The box the server said is wrong, with its message. */
  fieldError: { fieldId: string; message: string } | null;
  fields: readonly PrefillField[];
  onChange: (fieldId: string, value: string | boolean) => void;
  /** Ticked radio buttons are cleared within their group by the caller. */
  onChooseRadio: (groupFieldIds: readonly string[], chosenId: string) => void;
  showErrors: boolean;
  values: PrefillValues;
};

type PrefillItem =
  | { field: PrefillField; kind: "single" }
  | { buttons: PrefillField[]; kind: "radio"; required: boolean };

const labelClass = "text-[0.8125rem] font-semibold text-(--secondary)";
const errorClass = "text-xs font-semibold text-(--danger)";

function readingOrder(left: PrefillField, right: PrefillField) {
  return left.page - right.page || left.y - right.y || left.x - right.x;
}

/** The boxes in reading order, each radio group as one question. */
export function groupPrefillFields(
  fields: readonly PrefillField[],
): PrefillItem[] {
  const items: PrefillItem[] = [];
  const groups = new Map<string, PrefillField[]>();

  for (const field of [...fields].sort(readingOrder)) {
    if (field.type !== "radio") {
      items.push({ field, kind: "single" });
      continue;
    }

    const groupId = field.groupId ?? field.id;
    const buttons = groups.get(groupId);

    if (buttons) {
      buttons.push(field);
      continue;
    }

    const created = [field];

    groups.set(groupId, created);
    items.push({ buttons: created, kind: "radio", required: field.required });
  }

  return items;
}

function boxLabel(field: PrefillField): string {
  return field.label?.trim() || "Untitled box";
}

/** What is still missing in a required box, or undefined. */
export function findMissingPrefill(
  fields: readonly PrefillField[],
  values: PrefillValues,
): string | undefined {
  for (const item of groupPrefillFields(fields)) {
    if (item.kind === "radio") {
      if (
        item.required &&
        !item.buttons.some((button) => values[button.id] === true)
      ) {
        return item.buttons[0]?.id;
      }
      continue;
    }

    const { field } = item;
    const value = values[field.id];

    if (!field.required) {
      continue;
    }

    if (
      field.type === "checkbox" ? value !== true : !String(value ?? "").trim()
    ) {
      return field.id;
    }
  }

  return undefined;
}

export function PrefillInputs({
  disabled,
  fieldError,
  fields,
  onChange,
  onChooseRadio,
  showErrors,
  values,
}: PrefillInputsProps) {
  const missingId = showErrors ? findMissingPrefill(fields, values) : undefined;
  const errorFor = (ids: readonly string[]) => {
    if (fieldError && ids.includes(fieldError.fieldId)) {
      return fieldError.message;
    }

    return missingId && ids.includes(missingId)
      ? "This needs to be filled in."
      : undefined;
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-extrabold text-(--fg)">
          Fill in before sending
        </h2>
        <p className="text-sm leading-6 text-(--secondary)">
          These are written into the document before it goes out. Signers see
          them but can&apos;t change them.
        </p>
      </div>

      <ul className="grid gap-3 md:grid-cols-2">
        {groupPrefillFields(fields).map((item) => {
          if (item.kind === "radio") {
            const ids = item.buttons.map((button) => button.id);
            const error = errorFor(ids);

            return (
              <li className="well p-4" key={ids[0]}>
                <fieldset className="grid gap-2">
                  <legend className={labelClass}>
                    Choose one{item.required ? "" : " (optional)"}
                  </legend>
                  {item.buttons.map((button) => (
                    <label
                      className="flex min-h-11 items-center gap-2.5 text-sm text-(--fg)"
                      key={button.id}
                    >
                      <input
                        checked={values[button.id] === true}
                        disabled={disabled}
                        name={`prefill-${ids[0] ?? ""}`}
                        onChange={() => onChooseRadio(ids, button.id)}
                        type="radio"
                      />
                      {boxLabel(button)}
                    </label>
                  ))}
                  {error ? (
                    <span className={errorClass} role="alert">
                      {error}
                    </span>
                  ) : null}
                </fieldset>
              </li>
            );
          }

          const { field } = item;
          const label = `${boxLabel(field)}${field.required ? "" : " (optional)"}`;
          const error = errorFor([field.id]);
          const textValue =
            typeof values[field.id] === "string"
              ? (values[field.id] as string)
              : "";

          if (field.type === "checkbox") {
            return (
              <li className="well p-4" key={field.id}>
                <label className="flex min-h-11 items-center gap-2.5 text-sm font-semibold text-(--fg)">
                  <input
                    aria-invalid={error ? true : undefined}
                    checked={values[field.id] === true}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(field.id, event.target.checked)
                    }
                    type="checkbox"
                  />
                  {label}
                </label>
                {error ? (
                  <span className={errorClass} role="alert">
                    {error}
                  </span>
                ) : null}
              </li>
            );
          }

          return (
            <li className="well p-4" key={field.id}>
              <label className="grid gap-1.5">
                <span className={labelClass}>{label}</span>
                {field.type === "dropdown" ? (
                  <select
                    aria-invalid={error ? true : undefined}
                    className="field-input"
                    disabled={disabled}
                    onChange={(event) => onChange(field.id, event.target.value)}
                    value={textValue}
                  >
                    <option value="">Choose…</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-invalid={error ? true : undefined}
                    className="field-input"
                    disabled={disabled}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    maxLength={field.type === "number" ? 40 : 2000}
                    onChange={(event) => onChange(field.id, event.target.value)}
                    type={field.type === "date" ? "date" : "text"}
                    value={textValue}
                  />
                )}
                {error ? (
                  <span className={errorClass} role="alert">
                    {error}
                  </span>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
