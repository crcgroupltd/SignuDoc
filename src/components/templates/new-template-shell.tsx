"use client";

import { useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StepIndicator } from "@/components/shared/step-indicator";

// The first step of making a template on its own: name it and upload the
// document. Signers and fields come next, without an envelope.

export const templateSteps = ["Document", "Signers", "Place fields"];

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const genericError = "Something went wrong. Please try again.";

function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.pdf$/i, "")
    .trim()
    .slice(0, 160);
}

export function NewTemplateShell() {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function chooseFile(next: File | null) {
    setError(null);

    if (!next) {
      setFile(null);
      return;
    }

    if (
      next.type !== "application/pdf" &&
      !next.name.toLowerCase().endsWith(".pdf")
    ) {
      setFile(null);
      setError("Choose a PDF file.");
      return;
    }

    if (next.size > MAX_FILE_SIZE_BYTES) {
      setFile(null);
      setError("This file exceeds the 20 MB limit.");
      return;
    }

    setFile(next);

    if (!name.trim()) {
      setName(nameFromFile(next.name));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    if (!name.trim()) {
      setError("Give the template a name.");
      return;
    }

    if (!file) {
      setError("Choose the PDF to use.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const form = new FormData();

      form.set("name", name.trim());
      form.set("file", file);

      const response = await fetch("/api/templates", {
        body: form,
        method: "POST",
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
        description="Upload the document once. You name who signs it and place the fields next; nothing is sent."
        title="New template"
      />

      <StepIndicator current={1} steps={templateSteps} />

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
            placeholder="Consulting agreement"
            type="text"
            value={name}
          />
        </label>

        <label className="grid max-w-xl gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Document (PDF, up to 20 MB)
          </span>
          <input
            accept="application/pdf,.pdf"
            className="field-input py-2.5"
            disabled={isSubmitting}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>

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
            Cancel
          </ShellButton>
          <ShellButton loading={isSubmitting} type="submit">
            {isSubmitting ? "Uploading..." : "Next: signers"}
          </ShellButton>
        </div>
      </form>
    </div>
  );
}
