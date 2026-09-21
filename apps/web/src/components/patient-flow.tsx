"use client";

import { type ReactNode } from "react";
import type { SettingValue } from "@/lib/api";
import { Card, Chip, Select } from "@/components/ui";

/**
 * The settings this view owns, so the generated form does not also
 * render them and leave two controls for one value.
 */
export const FLOW_SETTING_KEYS = [
  "triageRequired",
  "paymentBeforeDispense",
  "requireDispenseBeforeComplete",
  "requirePaymentBeforeComplete",
  "combinedCounter",
] as const;

type Queue = Record<string, SettingValue | null | undefined>;

type Station = {
  key: string;
  name: string;
  /** Whether a patient goes through it, given these settings. */
  state: "always" | "sometimes" | "never";
  /** What decides it, in one line. */
  because: string;
  control?: ReactNode;
};

/**
 * What the flow actually looks like, given the settings (ENC-F-05).
 *
 * A dropdown reading *"Triage required: never"* is correct and tells an
 * owner nothing about what their clinic will do. A chain showing
 * **Check in → Doctor → Pay → Done** tells them immediately, which is
 * the whole reason this exists: a small clinic in Malaysia sends people
 * from the counter straight to the doctor, and the person setting that
 * up should be able to see that they have.
 *
 * Two kinds of station, and the difference is worth being plain about:
 *
 * - **Ones the clinic chooses** — triage, and whether payment comes
 *   before or after the pharmacy. These have a control.
 * - **Ones the visit decides** — a procedure happens if one was
 *   ordered, the pharmacy if something was prescribed. Turning those
 *   off is not a setting; it is the doctor not ordering anything. What
 *   *is* a setting is whether an unfinished one blocks the visit from
 *   closing.
 */
export function PatientFlow({
  queue,
  disabled,
  onChange,
}: {
  queue: Queue;
  disabled: boolean;
  onChange: (key: string, value: SettingValue) => void;
}) {
  const triage = String(queue["triageRequired"] ?? "OPTIONAL");
  const payFirst = queue["paymentBeforeDispense"] === true;
  const oneCounter = queue["combinedCounter"] === true;
  const mustDispense = queue["requireDispenseBeforeComplete"] !== false;
  const mustPay = queue["requirePaymentBeforeComplete"] !== false;

  const stations: Station[] = [
    {
      key: "checkin",
      name: "Check in",
      state: "always",
      because: "The front desk puts them in the queue.",
    },
    {
      key: "triage",
      name: "Triage",
      state:
        triage === "ALWAYS"
          ? "always"
          : triage === "NEVER"
            ? "never"
            : "sometimes",
      because:
        triage === "ALWAYS"
          ? "Every patient has their vitals taken first."
          : triage === "NEVER"
            ? "Skipped. Check-in sends them straight to the doctor."
            : "The front desk decides, patient by patient.",
      control: (
        <Select
          value={triage}
          disabled={disabled}
          onChange={(event) => onChange("triageRequired", event.target.value)}
        >
          <option value="ALWAYS">Every patient</option>
          <option value="OPTIONAL">The front desk decides</option>
          <option value="NEVER">Never — straight to the doctor</option>
        </Select>
      ),
    },
    {
      key: "doctor",
      name: "Doctor",
      state: "always",
      because:
        "The consultation. Everything else follows from what happens here.",
    },
    {
      key: "procedure",
      name: "Procedure",
      state: "sometimes",
      because: "Only when the doctor orders one.",
    },
  ];

  const pharmacy: Station = {
    key: "pharmacy",
    name: "Pharmacy",
    state: "sometimes",
    because: mustDispense
      ? "Only when something is prescribed — and the visit cannot close until it is handed over."
      : "Only when something is prescribed. The visit may close without it.",
    control: (
      <Select
        value={mustDispense ? "yes" : "no"}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            "requireDispenseBeforeComplete",
            event.target.value === "yes",
          )
        }
      >
        <option value="yes">Must be handed over first</option>
        <option value="no">Can finish without it</option>
      </Select>
    ),
  };

  const payment: Station = {
    key: "payment",
    name: "Pay",
    state: "always",
    because: mustPay
      ? "The visit cannot close while something is still owed."
      : "The visit may close with a balance outstanding.",
    control: (
      <Select
        value={mustPay ? "yes" : "no"}
        disabled={disabled}
        onChange={(event) =>
          onChange("requirePaymentBeforeComplete", event.target.value === "yes")
        }
      >
        <option value="yes">Must be settled first</option>
        <option value="no">Can finish owing</option>
      </Select>
    ),
  };

  if (oneCounter) {
    // One window, one queue. The statuses underneath are unchanged — the
    // patient is still "waiting for medicine" and then "waiting to pay"
    // — but to everybody in the building it is one stop, and the board
    // shows it as one.
    stations.push({
      key: "counter",
      name: "Counter",
      state: "always",
      because:
        "Medicine and the bill at the same window, by the same person. One queue on the board.",
      control: (
        <Select
          value={mustPay ? "yes" : "no"}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              "requirePaymentBeforeComplete",
              event.target.value === "yes",
            )
          }
        >
          <option value="yes">Must be settled first</option>
          <option value="no">Can finish owing</option>
        </Select>
      ),
    });
  } else {
    stations.push(...(payFirst ? [payment, pharmacy] : [pharmacy, payment]));
  }
  stations.push({
    key: "done",
    name: "Done",
    state: "always",
    because: "The visit is closed and counted.",
  });

  const route = stations
    .filter((station) => station.state !== "never")
    .map((station) =>
      station.state === "sometimes" ? `(${station.name})` : station.name,
    );

  return (
    <Card
      title="What a visit goes through"
      description="The route a patient takes, and the parts of it this clinic can change."
    >
      {/* The whole point: the resulting flow, in one line, updating as
          the controls change. */}
      <p className="rounded-md bg-surface-muted px-3 py-2.5 text-sm">
        {route.map((name, index) => (
          <span key={name}>
            {index > 0 && <span className="mx-1.5 text-muted">→</span>}
            <span
              className={name.startsWith("(") ? "text-muted" : "font-medium"}
            >
              {name}
            </span>
          </span>
        ))}
      </p>
      <p className="mt-1.5 text-xs text-muted">
        Names in brackets happen only when that visit needs them.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {stations.map((station) => (
          <div
            key={station.key}
            className={`flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2.5 ${
              station.state === "never"
                ? "border-dashed border-line opacity-60"
                : "border-line"
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {station.name}
                {station.state === "never" && (
                  <Chip tone="DISABLED">skipped</Chip>
                )}
                {station.state === "sometimes" && (
                  <Chip tone="INACTIVE">when needed</Chip>
                )}
              </p>
              <p className="mt-0.5 text-sm text-muted">{station.because}</p>
            </div>
            {station.control ? (
              <div className="w-60 shrink-0">{station.control}</div>
            ) : (
              <span className="shrink-0 self-center text-xs text-muted">
                always
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={oneCounter}
            disabled={disabled}
            onChange={(event) =>
              onChange("combinedCounter", event.target.checked)
            }
          />
          <span>
            <span className="font-medium">One counter does both.</span>{" "}
            <span className="text-muted">
              The same person hands over the medicine and takes the money, so
              the board shows one queue instead of two. This is how most small
              clinics run.
            </span>
          </span>
        </label>

        {!oneCounter && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={payFirst}
              disabled={disabled}
              onChange={(event) =>
                onChange("paymentBeforeDispense", event.target.checked)
              }
            />
            <span>
              <span className="font-medium">
                Pay before collecting medicine.
              </span>{" "}
              <span className="text-muted">
                Off, and the patient collects first and pays on the way out.
                Both are real; it depends where the counter is. With one counter
                the question does not arise.
              </span>
            </span>
          </label>
        )}
      </div>
    </Card>
  );
}
