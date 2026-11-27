"use client";

import { useState, type FormEvent } from "react";

import { getSignerPalette } from "@/components/envelopes/signer-palette";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { StepIndicator } from "@/components/shared/step-indicator";
import type { TemplateRole } from "@/lib/schemas/template";
import type { TemplateRolesData } from "@/lib/templates";

import { templateSteps } from "./new-template-shell";

// The second step of the template editor: the template's name and the
// roles that sign it ("Client", "Landlord"), in signing order. People are
// named only when the template is used.

type TemplateRolesShellProps = {
  maxRoles: number;
  template?: TemplateRolesData;
};

type EditableRole = {
  id: string;
  kind: "approver" | "signer";
  name: string;
  /** Signs at the same time as the role above. */
  withPrevious: boolean;
};

const genericError = "Something went wrong. Please try again.";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toEditable(roles: readonly TemplateRole[]): EditableRole[] {
  return roles.map((role, index) => ({
    id: role.id,
    kind: role.kind ?? "signer",
    name: role.name,
    withPrevious:
      index > 0 &&
      role.step !== undefined &&
      roles[index - 1]?.step === role.step,
  }));
}

function toRoles(roles: readonly EditableRole[]): TemplateRole[] {
  let step = 0;

  return roles.map((role, index) => {
    if (index === 0 || !role.withPrevious) {
      step += 1;
    }

    return { id: role.id, kind: role.kind, name: role.name.trim(), step };
  });
}

export function TemplateRolesShell({
  maxRoles,
  template,
}: TemplateRolesShellProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [roles, setRoles] = useState<EditableRole[]>(() =>
    toEditable(template?.roles ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!template) {
    return (
      <div className="space-y-5">
        <PageHeader title="Edit template" />
        <StatusPanel
          action={{ href: "/templates", label: "Back to templates" }}
          description="We couldn't load this template. Try again in a moment."
          title="This template can't be edited"
          tone="error"
        />
      </div>
    );
  }

  const removedRoleCount = template.roles.filter(
    (role) => !roles.some((kept) => kept.id === role.id),
  ).length;

  function update(index: number, patch: Partial<EditableRole>) {
    setError(null);
    setRoles((current) =>
      current.map((role, roleIndex) =>
        roleIndex === index ? { ...role, ...patch } : role,
      ),
    );
  }

  function move(index: number, offset: -1 | 1) {
    setError(null);
    setRoles((current) => {
      const next = [...current];
      const target = index + offset;
      const moving = next[index];
      const other = next[target];

      if (!moving || !other) {
        return current;
      }

      next[index] = other;
      next[target] = moving;

      return next.map((role, roleIndex) =>
        roleIndex === 0 ? { ...role, withPrevious: false } : role,
      );
    });
  }

  function addRole() {
    setError(null);
    setRoles((current) => [
      ...current,
      {
        id: newId(),
        kind: "signer",
        name: `Signer ${String(current.length + 1)}`,
        withPrevious: false,
      },
    ]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!template || isSubmitting) {
      return;
    }

    if (!name.trim()) {
      setError("Give the template a name.");
      return;
    }

    if (roles.some((role) => !role.name.trim())) {
      setError("Give each signer a name, such as Client or Landlord.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (name.trim() !== template.name) {
        const renamed = await fetch(`/api/templates/${template.id}`, {
          body: JSON.stringify({ name: name.trim() }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        });

        if (!renamed.ok) {
          const payload = (await renamed.json().catch(() => null)) as {
            error?: string;
          } | null;

          setError(payload?.error ?? genericError);
          setIsSubmitting(false);
          return;
        }
      }

      const response = await fetch(`/api/templates/${template.id}/roles`, {
        body: JSON.stringify({ roles: toRoles(roles) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        setError(payload?.error ?? genericError);
        setIsSubmitting(false);
        return;
      }

      window.location.assign(payload.redirectPath);
    } catch {
      setError(genericError);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        description="Name each place in the signing order. You choose the actual people each time you use the template."
        title="Edit template"
      />

      <StepIndicator current={2} steps={templateSteps} />

      <form
        className="panel space-y-6 p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="1"
        noValidate
        onSubmit={handleSubmit}
      >
        <label className="grid max-w-xl gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Template name
          </span>
          <input
            className="field-input"
            disabled={isSubmitting}
            maxLength={160}
            onChange={(event) => {
              setError(null);
              setName(event.target.value);
            }}
            type="text"
            value={name}
          />
        </label>

        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-lg font-extrabold text-(--fg)">
              Who signs, in order
            </h2>
            <p className="text-sm leading-6 text-(--secondary)">
              Use names that describe the part each person plays, such as Client
              or Landlord. Approvers approve or reject and have no fields.
            </p>
          </div>

          <ol className="space-y-3">
            {roles.map((role, index) => {
              const palette = getSignerPalette(index);

              return (
                <li className="well space-y-3 p-4 sm:p-5" key={role.id}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: palette.color }}
                    />
                    <input
                      aria-label={`Name of signer ${String(index + 1)}`}
                      className="field-input min-w-0 flex-1"
                      disabled={isSubmitting}
                      maxLength={60}
                      onChange={(event) =>
                        update(index, { name: event.target.value })
                      }
                      type="text"
                      value={role.name}
                    />
                    <select
                      aria-label={`What ${role.name || "this signer"} does`}
                      className="field-input w-auto"
                      disabled={isSubmitting}
                      onChange={(event) =>
                        update(index, {
                          kind:
                            event.target.value === "approver"
                              ? "approver"
                              : "signer",
                        })
                      }
                      value={role.kind}
                    >
                      <option value="signer">Signs</option>
                      <option value="approver">Approves</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {index > 0 ? (
                      <label className="mr-auto flex min-h-11 items-center gap-2 text-sm text-(--secondary)">
                        <input
                          checked={role.withPrevious}
                          disabled={isSubmitting}
                          onChange={(event) =>
                            update(index, {
                              withPrevious: event.target.checked,
                            })
                          }
                          type="checkbox"
                        />
                        Signs at the same time as {roles[index - 1]?.name}
                      </label>
                    ) : (
                      <span className="mr-auto" />
                    )}
                    <button
                      aria-label={`Move ${role.name} up`}
                      className="btn-quiet min-h-11 px-3"
                      disabled={isSubmitting || index === 0}
                      onClick={() => move(index, -1)}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${role.name} down`}
                      className="btn-quiet min-h-11 px-3"
                      disabled={isSubmitting || index === roles.length - 1}
                      onClick={() => move(index, 1)}
                      type="button"
                    >
                      ↓
                    </button>
                    <button
                      className="btn-quiet btn-quiet-danger min-h-11 px-3"
                      disabled={isSubmitting || roles.length === 1}
                      onClick={() => {
                        setError(null);
                        setRoles((current) =>
                          current
                            .filter((_, roleIndex) => roleIndex !== index)
                            .map((entry, roleIndex) =>
                              roleIndex === 0
                                ? { ...entry, withPrevious: false }
                                : entry,
                            ),
                        );
                      }}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          <ShellButton
            disabled={isSubmitting || roles.length >= maxRoles}
            onClick={addRole}
            variant="secondary"
          >
            + Add a signer
          </ShellButton>
        </div>

        {removedRoleCount > 0 ? (
          <p className="notice notice-warning">
            Fields placed for a removed signer are removed with them when you
            continue.
          </p>
        ) : null}

        {error ? (
          <div className="notice notice-danger" role="alert">
            <p>{error}</p>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ShellButton
            disabled={isSubmitting}
            href="/templates"
            variant="secondary"
          >
            Back to templates
          </ShellButton>
          <ShellButton loading={isSubmitting} type="submit">
            {isSubmitting ? "Saving..." : "Next: place fields"}
          </ShellButton>
        </div>
      </form>
    </div>
  );
}
