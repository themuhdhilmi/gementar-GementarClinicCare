"use client";

import { useId } from "react";
import { assessPassword } from "@/lib/password";
import { Field, Input } from "./ui";

const BAR_TONE = [
  "bg-danger",
  "bg-danger",
  "bg-warning",
  "bg-primary",
  "bg-success",
];

/**
 * Live feedback while typing, and enough room underneath for the server to
 * explain a refusal in its own words — which matters most for the breached
 * password case, where "choose another" without a reason feels arbitrary.
 */
export function PasswordField({
  value,
  onChange,
  label = "New password",
  context,
  serverMessage,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  context?: { email?: string; name?: string };
  serverMessage?: string | null;
}) {
  const id = useId();
  const strength = assessPassword(value, context);

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} htmlFor={id}>
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          minLength={12}
          maxLength={128}
          required
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>

      <div className="flex items-center gap-2">
        <div className="flex h-1.5 flex-1 gap-1" aria-hidden>
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={`flex-1 rounded-full ${
                value.length > 0 && index < strength.score
                  ? BAR_TONE[strength.score]
                  : "bg-line"
              }`}
            />
          ))}
        </div>
        <span className="w-24 text-right text-xs font-medium text-muted">
          {strength.label}
        </span>
      </div>

      <p className="text-xs text-muted" aria-live="polite">
        {strength.hint}
      </p>

      {serverMessage && (
        <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {serverMessage}
        </p>
      )}
    </div>
  );
}
