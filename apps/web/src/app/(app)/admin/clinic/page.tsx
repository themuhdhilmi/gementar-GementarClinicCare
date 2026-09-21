"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  api,
  SETTINGS_GROUP_LABEL,
  settingLabel,
  type SettingField,
  type SettingValue,
  type SettingsDocument,
  type TenantOverview,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { FLOW_SETTING_KEYS, PatientFlow } from "@/components/patient-flow";
import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  Input,
  PageHeader,
  Skeleton,
  TextField,
} from "@/components/ui";

/**
 * Admin → Clinic settings (TEN-F-01, TEN-F-04, TEN-F-05).
 *
 * The settings half of this screen is generated from the schema the API
 * serves, not written out by hand. Adding a setting on the server therefore
 * makes it appear here, with its help text and its default, and there is no
 * second list to keep in step.
 */
export default function ClinicPage() {
  const { can } = useSession();
  const [data, setData] = useState<TenantOverview | null>(null);
  const [profile, setProfile] = useState({
    name: "",
    timezone: "",
    tin: "",
    businessRegNo: "",
  });
  const [draft, setDraft] = useState<SettingsDocument>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * ENC-F-26: the change is fine, the timing is not.
   *
   * Held rather than shown as an error, because the answer is a
   * decision — move those patients on, or go ahead knowing they are
   * there — and an error message cannot offer either.
   */
  const [blocked, setBlocked] = useState<{
    detail: string;
    count: number;
  } | null>(null);

  const load = useCallback(async () => {
    const next = await api<TenantOverview>("/tenant");
    setData(next);
    setProfile({
      name: next.tenant.name,
      timezone: next.tenant.timezone,
      tin: next.tenant.tin ?? "",
      businessRegNo: next.tenant.businessRegNo ?? "",
    });
    setDraft(next.settings);
  }, []);

  useAsyncEffect(() => load(), [load]);

  if (!data)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-64" />
      </div>
    );
  const readOnly = !can("admin.settings");

  async function save(what: string, run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await load();
      setNotice(`${what} saved.`);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === "settings_change_blocked"
      ) {
        const blockers =
          ((caught.problem.errors as { blockers?: unknown } | undefined)
            ?.blockers as Array<{ detail: string; count: number }>) ?? [];
        setBlocked({
          detail: blockers.map((b) => b.detail).join(" "),
          count: blockers.reduce((sum, b) => sum + b.count, 0),
        });
        return;
      }
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Save the flow, having been told who is still standing in it. */
  function saveSettings(acknowledge = false) {
    setBlocked(null);
    return save("Settings", () =>
      api("/tenant/settings", {
        method: "PATCH",
        body: { settings: draft, ...(acknowledge ? { acknowledge: true } : {}) },
      }),
    );
  }

  const groups = [...new Set(data.schema.fields.map((field) => field.group))];
  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Clinic settings"
        description="How this clinic works, and what it prints. Changing one of these changes every branch."
        meta={
          <>
            <Chip tone={data.tenant.status} dot>
              {data.tenant.status}
            </Chip>
            <span className="text-muted">
              {data.tenant.name} · {data.tenant.slug} · {data.tenant.currency}
            </span>
          </>
        }
      />

      {error && <Alert title="Not saved">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {readOnly && (
        <Alert tone="info">
          You can see these, and an administrator changes them.
        </Alert>
      )}

      <Card
        title="The clinic"
        description="What appears on printed documents and in e-Invoice submissions."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={profile.name}
            disabled={readOnly}
            onChange={(event) =>
              setProfile({ ...profile, name: event.target.value })
            }
          />
          <TextField
            label="Time zone"
            hint="Reports and opening hours are read in this zone."
            value={profile.timezone}
            disabled={readOnly}
            onChange={(event) =>
              setProfile({ ...profile, timezone: event.target.value })
            }
          />
          <TextField
            label="Business registration number"
            hint="SSM number, printed on invoices."
            value={profile.businessRegNo}
            disabled={readOnly}
            onChange={(event) =>
              setProfile({ ...profile, businessRegNo: event.target.value })
            }
          />
          <TextField
            label="Tax identification number"
            hint="TIN, needed for MyInvois when e-Invoice is switched on."
            value={profile.tin}
            disabled={readOnly}
            onChange={(event) =>
              setProfile({ ...profile, tin: event.target.value })
            }
          />
        </div>
        <Field
          label="Web address"
          hint="The subdomain never changes: documents and links depend on it."
        >
          <Input value={data.tenant.slug} disabled readOnly />
        </Field>
        {!readOnly && (
          <div className="mt-4">
            <Button
              loading={busy}
              onClick={() =>
                void save("Clinic details", () =>
                  api("/tenant", {
                    method: "PATCH",
                    body: {
                      name: profile.name,
                      timezone: profile.timezone,
                      tin: profile.tin || undefined,
                      businessRegNo: profile.businessRegNo || undefined,
                    },
                  }),
                )
              }
            >
              Save clinic details
            </Button>
          </div>
        )}
      </Card>

      {/* ENC-F-05. The four settings that decide the route are shown as
          the route, above the generated form, and filtered out of it —
          two controls for one value is worse than none. */}
      <PatientFlow
        queue={draft["queue"] ?? {}}
        disabled={readOnly}
        onChange={(key, value) =>
          setDraft({ ...draft, queue: { ...draft["queue"], [key]: value } })
        }
      />

      {groups.map((group) => (
        <Card
          key={group}
          title={SETTINGS_GROUP_LABEL[group] ?? group}
          description={
            group === "queue"
              ? "The rest of the queue. What a visit goes through is above."
              : "Applies everywhere unless a branch overrides it."
          }
        >
          <div className="flex flex-col gap-4">
            {data.schema.fields
              .filter((field) => field.group === group)
              .filter(
                (field) =>
                  !(
                    field.group === "queue" &&
                    (FLOW_SETTING_KEYS as readonly string[]).includes(field.key)
                  ),
              )
              .map((field) => (
                <SettingRow
                  key={`${field.group}.${field.key}`}
                  field={field}
                  value={draft[field.group]?.[field.key] ?? field.default}
                  disabled={readOnly}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      [field.group]: {
                        ...draft[field.group],
                        [field.key]: value,
                      },
                    })
                  }
                />
              ))}
          </div>
        </Card>
      ))}

      {blocked && (
        <Alert
          tone="warning"
          title="Somebody is still standing there"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => void saveSettings(true)}
                loading={busy}
              >
                Change it anyway
              </Button>
              <Button variant="ghost" onClick={() => setBlocked(null)}>
                Leave it as it is
              </Button>
            </>
          }
        >
          {blocked.detail} Changing the flow now will not lose them — they stay
          on the reception board — but the screen that was looking after them
          will disappear.
        </Alert>
      )}

      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button
            loading={busy}
            disabled={!changed}
            onClick={() => void saveSettings()}
          >
            Save settings
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setDraft(data.settings)}>
              Discard changes
            </Button>
          )}
          <span className="text-sm text-muted">
            Schema version {data.schema.version}
          </span>
        </div>
      )}

      <Card
        title="Modules"
        description="What this clinic has switched on. Ask us to change one."
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.schema.modules.map((module) => (
            <li key={module.key} className="flex items-start gap-2 text-sm">
              <span
                className={`mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium ${
                  data.modules[module.key]
                    ? "bg-success-soft text-success"
                    : "bg-surface-muted text-muted"
                }`}
              >
                {data.modules[module.key] ? "On" : "Off"}
              </span>
              <span className={data.modules[module.key] ? "" : "text-muted"}>
                {module.label}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function SettingRow({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField;
  value: SettingValue;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
}) {
  const label = settingLabel(field.key);

  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="text-sm font-medium">{label}</span>
          <span className="block text-sm text-muted">{field.help}</span>
        </span>
      </label>
    );
  }

  return (
    <Field label={label} hint={field.help}>
      <Input
        type={field.type === "number" ? "number" : "text"}
        value={String(value)}
        disabled={disabled}
        className="max-w-xs"
        onChange={(event) =>
          onChange(
            field.type === "number"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </Field>
  );
}
