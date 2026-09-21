"use client";

import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  api,
  upload,
  SETTINGS_GROUP_LABEL,
  settingLabel,
  WEEKDAYS,
  type BranchDetail,
  type OperatingHours,
  type SettingField,
  type SettingsDocument,
  type TenantOverview,
  type Weekday,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { Cell, Column, DataTable } from "@/components/data-table";
import {
  Alert,
  Button,
  Chip,
  Drawer,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  TextField,
} from "@/components/ui";

type Draft = {
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postcode: string;
  phone: string;
  email: string;
  licenceNo: string;
  operatingHours: OperatingHours;
};

const BLANK: Draft = {
  code: "",
  name: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postcode: "",
  phone: "",
  email: "",
  licenceNo: "",
  operatingHours: {},
};

function toDraft(branch: BranchDetail): Draft {
  return {
    code: branch.code,
    name: branch.name,
    addressLine1: branch.addressLine1 ?? "",
    addressLine2: branch.addressLine2 ?? "",
    city: branch.city ?? "",
    state: branch.state ?? "",
    postcode: branch.postcode ?? "",
    phone: branch.phone ?? "",
    email: branch.email ?? "",
    licenceNo: branch.licenceNo ?? "",
    operatingHours: branch.operatingHours ?? {},
  };
}

/**
 * Admin → Branches (TEN-F-06, TEN-F-07, TEN-F-09, TEN-F-10).
 *
 * One clinic will have one branch and never open this screen twice. The design
 * assumes that: the list is short, the editor is one drawer rather than a
 * wizard, and the things that are permanent — the code above all — say so at
 * the point of typing rather than in an error afterwards.
 */
export default function BranchesPage() {
  const { can } = useSession();
  const [branches, setBranches] = useState<BranchDetail[] | null>(null);
  const [tenant, setTenant] = useState<TenantOverview | null>(null);
  const [editing, setEditing] = useState<BranchDetail | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [confirming, setConfirming] = useState<BranchDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, overview] = await Promise.all([
      api<{ items: BranchDetail[] }>("/branches/all"),
      api<TenantOverview>("/tenant"),
    ]);
    setBranches(list.items);
    setTenant(overview);
  }, []);

  useAsyncEffect(() => load(), [load]);

  if (!can("admin.settings")) {
    return <Alert tone="info">Branches are managed by an administrator.</Alert>;
  }
  if (!branches || !tenant)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64" />
      </div>
    );

  async function act(what: string, run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await load();
      setNotice(what);
      return true;
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  function open(branch: BranchDetail | "new") {
    setEditing(branch);
    setDraft(branch === "new" ? BLANK : toDraft(branch));
    setError(null);
  }

  const creating = editing === "new";
  const current = editing === "new" ? null : editing;

  const columns: Array<Column<BranchDetail>> = [
    {
      key: "code",
      header: "Code",
      width: "w-24",
      cell: (branch) => (
        <span className="font-mono text-xs tabular">{branch.code}</span>
      ),
    },
    {
      key: "name",
      header: "Name",
      cell: (branch) => (
        <Cell
          primary={branch.name}
          secondary={
            [branch.city, branch.state].filter(Boolean).join(", ") || undefined
          }
        />
      ),
    },
    {
      key: "open",
      header: "Open",
      hideBelow: "md",
      cell: (branch) => (
        <span className="text-muted">
          {openDaysSummary(branch.operatingHours)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (branch) => <Chip tone={branch.status}>{branch.status}</Chip>,
    },
    {
      key: "actions",
      header: "",
      numeric: true,
      cell: (branch) => (
        <div className="flex justify-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => open(branch)}>
            Edit
          </Button>
          {branch.status === "ACTIVE" ? (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setConfirming(branch)}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              variant="quiet"
              size="sm"
              onClick={() =>
                void act(`${branch.name} is open again.`, () =>
                  api(`/branches/${branch.id}/activate`, { method: "POST" }),
                )
              }
            >
              Reactivate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Branches"
        description="Where the clinic sees patients. Every record carries the branch it happened at, which is why a branch is deactivated rather than removed."
        meta={
          <span className="text-muted">
            {branches.filter((b) => b.status === "ACTIVE").length} open of{" "}
            {branches.length}
          </span>
        }
        actions={<Button onClick={() => open("new")}>Add a branch</Button>}
      />

      {error && !editing && <Alert title="Not done">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <DataTable
        rows={branches}
        columns={columns}
        rowKey={(branch) => branch.id}
        rowTone={(branch) => (branch.status === "ACTIVE" ? undefined : "muted")}
        caption="Branches"
        empty="No branches yet"
        emptyHint="A clinic needs at least one before anyone can be given a role."
      />

      <Drawer
        open={editing !== null}
        title={creating ? "Add a branch" : (current?.name ?? "")}
        onClose={() => setEditing(null)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Close
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                const body = {
                  ...(creating ? { code: draft.code } : {}),
                  name: draft.name,
                  addressLine1: draft.addressLine1 || undefined,
                  addressLine2: draft.addressLine2 || undefined,
                  city: draft.city || undefined,
                  state: draft.state || undefined,
                  postcode: draft.postcode || undefined,
                  phone: draft.phone || undefined,
                  email: draft.email || undefined,
                  licenceNo: draft.licenceNo || undefined,
                  operatingHours: draft.operatingHours,
                };
                const ok = await act(
                  creating ? `${draft.name} added.` : `${draft.name} saved.`,
                  () =>
                    creating
                      ? api("/branches", { method: "POST", body })
                      : api(`/branches/${current!.id}`, {
                          method: "PATCH",
                          body,
                        }),
                );
                if (ok) setEditing(null);
              }}
            >
              {creating ? "Add branch" : "Save"}
            </Button>
          </div>
        }
      >
        {error && <Alert title="Not saved">{error}</Alert>}

        <div className="mt-2 flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Code"
              hint={
                creating
                  ? "Two to eight letters or digits. It becomes part of every invoice number, so it can never be changed."
                  : "Part of every document number already issued here, so it is permanent."
              }
            >
              <Input
                value={draft.code}
                disabled={!creating}
                maxLength={8}
                placeholder="KL01"
                className="font-mono uppercase"
                onChange={(event) =>
                  setDraft({ ...draft, code: event.target.value.toUpperCase() })
                }
              />
            </Field>
            <TextField
              label="Name"
              value={draft.name}
              placeholder="Cawangan Cheras"
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Address"
              value={draft.addressLine1}
              onChange={(event) =>
                setDraft({ ...draft, addressLine1: event.target.value })
              }
            />
            <TextField
              label="Address line 2"
              value={draft.addressLine2}
              onChange={(event) =>
                setDraft({ ...draft, addressLine2: event.target.value })
              }
            />
            <TextField
              label="City"
              value={draft.city}
              onChange={(event) =>
                setDraft({ ...draft, city: event.target.value })
              }
            />
            <TextField
              label="State"
              value={draft.state}
              onChange={(event) =>
                setDraft({ ...draft, state: event.target.value })
              }
            />
            <TextField
              label="Postcode"
              hint="Five digits."
              value={draft.postcode}
              inputMode="numeric"
              maxLength={5}
              onChange={(event) =>
                setDraft({ ...draft, postcode: event.target.value })
              }
            />
            <TextField
              label="Phone"
              value={draft.phone}
              onChange={(event) =>
                setDraft({ ...draft, phone: event.target.value })
              }
            />
            <TextField
              label="Email"
              type="email"
              value={draft.email}
              onChange={(event) =>
                setDraft({ ...draft, email: event.target.value })
              }
            />
            <TextField
              label="Clinic licence number"
              hint="Printed on documents issued here."
              value={draft.licenceNo}
              onChange={(event) =>
                setDraft({ ...draft, licenceNo: event.target.value })
              }
            />
          </div>

          <HoursEditor
            hours={draft.operatingHours}
            onChange={(operatingHours) =>
              setDraft({ ...draft, operatingHours })
            }
          />

          {current && (
            <>
              <LetterheadEditor branch={current} onSaved={load} />
              <BranchSettings
                branch={current}
                fields={tenant.schema.fields}
                clinic={tenant.settings}
                onSaved={load}
              />
            </>
          )}
        </div>
      </Drawer>

      <Modal
        open={confirming !== null}
        title={`Deactivate ${confirming?.name ?? ""}?`}
        onClose={() => setConfirming(null)}
      >
        <p className="text-sm text-muted">
          Nobody will be able to work there and nothing already recorded is
          touched. It can be reopened at any time. If work is still open at the
          branch, this will be refused and say how much.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(null)}>
            Keep it open
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              const branch = confirming!;
              const ok = await act(`${branch.name} is closed.`, () =>
                api(`/branches/${branch.id}/deactivate`, {
                  method: "POST",
                  body: {},
                }),
              );
              if (ok) setConfirming(null);
            }}
          >
            Deactivate
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function openDaysSummary(hours: OperatingHours): string {
  const open = WEEKDAYS.filter(({ key }) => (hours?.[key]?.length ?? 0) > 0);
  if (open.length === 0) return "Not set";
  if (open.length === 7) return "Every day";
  return open.map(({ label }) => label.slice(0, 3)).join(" ");
}

/** TEN-F-06: per weekday, more than one range, because clinics shut for lunch. */
function HoursEditor({
  hours,
  onChange,
}: {
  hours: OperatingHours;
  onChange: (hours: OperatingHours) => void;
}) {
  function setDay(day: Weekday, ranges: Array<[string, string]>) {
    const next = { ...hours };
    if (ranges.length === 0) delete next[day];
    else next[day] = ranges;
    onChange(next);
  }

  return (
    <fieldset className="rounded-md border border-line p-4">
      <legend className="px-1 text-sm font-medium">Opening hours</legend>
      <p className="mb-3 text-sm text-muted">
        Leave a day empty when the clinic is shut. Add a second range for a
        lunch break.
      </p>

      <div className="flex flex-col gap-2">
        {WEEKDAYS.map(({ key, label }) => {
          const ranges = hours[key] ?? [];
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-sm">{label}</span>
              {ranges.length === 0 && (
                <span className="text-sm text-muted">Closed</span>
              )}
              {ranges.map((range, index) => (
                <span key={index} className="flex items-center gap-1">
                  <Input
                    type="time"
                    value={range[0]}
                    className="h-8 w-28 text-sm"
                    onChange={(event) => {
                      const next = ranges.map((r, i): [string, string] =>
                        i === index ? [event.target.value, r[1]] : r,
                      );
                      setDay(key, next);
                    }}
                  />
                  <span className="text-muted">to</span>
                  <Input
                    type="time"
                    value={range[1]}
                    className="h-8 w-28 text-sm"
                    onChange={(event) => {
                      const next = ranges.map((r, i): [string, string] =>
                        i === index ? [r[0], event.target.value] : r,
                      );
                      setDay(key, next);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove this range on ${label}`}
                    onClick={() =>
                      setDay(
                        key,
                        ranges.filter((_, i) => i !== index),
                      )
                    }
                  >
                    ×
                  </Button>
                </span>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDay(key, [
                    ...ranges,
                    ranges.length === 0
                      ? ["09:00", "17:00"]
                      : ["14:00", "18:00"],
                  ])
                }
              >
                Add hours
              </Button>
              {ranges.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const next: OperatingHours = {};
                    for (const day of WEEKDAYS)
                      next[day.key] = ranges.map(
                        (r) => [...r] as [string, string],
                      );
                    onChange(next);
                  }}
                >
                  Copy to every day
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** TEN-F-10: what a printed document carries, with the logo shown as it is. */
function LetterheadEditor({
  branch,
  onSaved,
}: {
  branch: BranchDetail;
  onSaved: () => Promise<void>;
}) {
  const [headerText, setHeaderText] = useState(branch.letterhead.headerText);
  const [footerText, setFooterText] = useState(branch.letterhead.footerText);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onSaved();
      setVersion((n) => n + 1);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="rounded-md border border-line p-4">
      <legend className="px-1 text-sm font-medium">Letterhead</legend>
      <p className="mb-3 text-sm text-muted">
        Printed at the top and bottom of receipts, prescriptions and medical
        certificates.
      </p>
      {error && <Alert title="Not saved">{error}</Alert>}

      <div className="mt-2 flex items-start gap-4">
        <div className="flex size-24 shrink-0 items-center justify-center rounded-md border border-dashed border-line bg-surface-muted">
          {branch.hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/branches/${branch.id}/letterhead/logo?v=${version}`}
              alt="Branch logo"
              className="max-h-20 max-w-20 object-contain"
            />
          ) : (
            <span className="px-2 text-center text-xs text-muted">No logo</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void run(() =>
                  upload(
                    `/branches/${branch.id}/letterhead/logo`,
                    "logo",
                    file,
                  ),
                );
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => picker.current?.click()}
            >
              {branch.hasLogo ? "Replace logo" : "Upload logo"}
            </Button>
            {branch.hasLogo && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run(() =>
                    api(`/branches/${branch.id}/letterhead/logo`, {
                      method: "DELETE",
                    }),
                  )
                }
              >
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">PNG, JPEG or SVG, up to 512 KB.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <TextField
          label="Header text"
          hint="Under the logo: the clinic name, registration number, address."
          value={headerText}
          onChange={(event) => setHeaderText(event.target.value)}
        />
        <TextField
          label="Footer text"
          hint="At the foot of every page."
          value={footerText}
          onChange={(event) => setFooterText(event.target.value)}
        />
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() =>
              void run(() =>
                api(`/branches/${branch.id}/letterhead`, {
                  method: "PATCH",
                  body: { headerText, footerText },
                }),
              )
            }
          >
            Save letterhead text
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

/** TEN-F-09: a branch overrides the clinic only where it says something. */
function BranchSettings({
  branch,
  fields,
  clinic,
  onSaved,
}: {
  branch: BranchDetail;
  fields: SettingField[];
  clinic: SettingsDocument;
  onSaved: () => Promise<void>;
}) {
  const [overrides, setOverrides] = useState<SettingsDocument>(
    branch.settings ?? {},
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function clinicValue(field: SettingField) {
    return clinic[field.group]?.[field.key] ?? field.default;
  }

  return (
    <fieldset className="rounded-md border border-line p-4">
      <legend className="px-1 text-sm font-medium">
        Settings just for this branch
      </legend>
      <p className="mb-3 text-sm text-muted">
        Everything follows the clinic unless it is overridden here. Only the
        overrides are stored, so a change to the clinic still reaches this
        branch.
      </p>
      {error && <Alert title="Not saved">{error}</Alert>}

      <div className="flex flex-col gap-3">
        {fields.map((field) => {
          const overridden = overrides[field.group]?.[field.key] !== undefined;
          const shown = overridden
            ? overrides[field.group]![field.key]!
            : clinicValue(field);
          return (
            <div
              key={`${field.group}.${field.key}`}
              className="flex flex-wrap items-center gap-3"
            >
              <label className="flex w-64 shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={overridden}
                  onChange={(event) => {
                    const group = { ...overrides[field.group] };
                    if (event.target.checked)
                      group[field.key] = clinicValue(field);
                    else delete group[field.key];
                    const next = { ...overrides };
                    if (Object.keys(group).length === 0)
                      delete next[field.group];
                    else next[field.group] = group;
                    setOverrides(next);
                  }}
                />
                <span>
                  {settingLabel(field.key)}
                  <span className="block text-xs text-muted">
                    {SETTINGS_GROUP_LABEL[field.group] ?? field.group}
                  </span>
                </span>
              </label>

              {field.type === "boolean" ? (
                <input
                  type="checkbox"
                  className="size-4"
                  checked={Boolean(shown)}
                  disabled={!overridden}
                  onChange={(event) =>
                    setOverrides({
                      ...overrides,
                      [field.group]: {
                        ...overrides[field.group],
                        [field.key]: event.target.checked,
                      },
                    })
                  }
                />
              ) : (
                <Input
                  type={field.type === "number" ? "number" : "text"}
                  value={String(shown)}
                  disabled={!overridden}
                  className="h-8 max-w-[10rem] text-sm"
                  onChange={(event) =>
                    setOverrides({
                      ...overrides,
                      [field.group]: {
                        ...overrides[field.group],
                        [field.key]:
                          field.type === "number"
                            ? Number(event.target.value)
                            : event.target.value,
                      },
                    })
                  }
                />
              )}

              {!overridden && (
                <span className="text-xs text-muted">follows the clinic</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // A box unticked here has to *remove* the override, not write
              // down the clinic's current value — otherwise the branch would
              // be frozen on it. `null` is how the API is told to remove one.
              const patch: SettingsDocument = {};
              for (const field of fields) {
                const value = overrides[field.group]?.[field.key];
                patch[field.group] = {
                  ...patch[field.group],
                  [field.key]: value === undefined ? null : value,
                };
              }
              await api(`/branches/${branch.id}/settings`, {
                method: "PATCH",
                body: { settings: patch },
              });
              await onSaved();
            } catch (caught) {
              setError(
                caught instanceof ApiError
                  ? caught.message
                  : "Something went wrong.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Save branch settings
        </Button>
      </div>
    </fieldset>
  );
}
