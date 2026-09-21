"use client";

import type { VisitStep } from "@/lib/api";

/**
 * Where this visit has got to (ENC-F-11).
 *
 * A row of steps above the chart, so the first thing anybody sees on
 * opening a patient is where they are in the building rather than a
 * status word they have to translate. It is the same question the
 * board answers for the whole clinic, asked about one person.
 *
 * The steps come from the server, because which ones apply depends on
 * the clinic's settings *and* on what this visit actually did — no
 * triage step where the clinic has no triage, no procedure step unless
 * one was ordered, one counter where one person does both.
 *
 * Deliberately not a progress bar with a percentage. A visit is not
 * 60% finished; it is at the pharmacy.
 */
export function VisitFlow({ steps }: { steps: VisitStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol
      className="scroll-slim mb-5 flex flex-wrap items-center gap-y-2 overflow-x-auto rounded-xl border border-line bg-surface-sunken px-4 py-3"
      aria-label="Where this visit has got to"
    >
      {steps.map((step, index) => (
        <li key={step.key} className="flex shrink-0 items-center">
          {index > 0 && (
            <span
              aria-hidden
              className={`mx-1.5 h-px w-5 ${
                step.state === "upcoming" || step.state === "skipped"
                  ? "bg-line"
                  : "bg-primary/50"
              }`}
            />
          )}
          <span
            aria-current={step.state === "current" ? "step" : undefined}
            title={
              step.state === "skipped"
                ? "This clinic does not do this step"
                : step.state === "done"
                  ? "Done"
                  : step.state === "current"
                    ? "Here now"
                    : "Still to come"
            }
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${
              step.state === "current"
                ? "bg-primary font-medium text-on-primary shadow-e1"
                : step.state === "done"
                  ? "bg-primary-soft text-primary-ink"
                  : step.state === "skipped"
                    ? "text-muted line-through decoration-line"
                    : "border border-dashed border-line text-muted"
            }`}
          >
            {step.state === "done" && (
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-3"
              >
                <path d="m5 13 4 4L19 7" />
              </svg>
            )}
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
