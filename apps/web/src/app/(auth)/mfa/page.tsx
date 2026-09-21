"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export default function MfaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  async function verify(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/mfa/verify", {
        method: "POST",
        body: {
          code: value,
          trustDevice,
          deviceLabel: navigator.userAgent.slice(0, 120),
        },
      });
      router.replace("/workspace");
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not verify that code.",
      );
      setCode("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Two-step verification"
      description={
        mode === "totp"
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of the recovery codes you saved."
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void verify(code);
        }}
      >
        {error && <Alert>{error}</Alert>}

        {mode === "totp" ? (
          <Field label="Verification code">
            <Input
              ref={inputRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              aria-label="Six digit verification code"
              className="text-center font-mono text-2xl tracking-[0.5em]"
              onChange={(event) => {
                const digits = event.target.value
                  .replace(/\D/g, "")
                  .slice(0, 6);
                setCode(digits);
                // Auto-submit on the sixth digit: nobody should have to reach
                // for the mouse to finish signing in.
                if (digits.length === 6) void verify(digits);
              }}
            />
          </Field>
        ) : (
          <Field label="Recovery code" hint="Each code works once.">
            <Input
              ref={inputRef}
              autoComplete="one-time-code"
              value={code}
              placeholder="XXXXX-XXXXX"
              className="font-mono text-lg"
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </Field>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={trustDevice}
            onChange={(event) => setTrustDevice(event.target.checked)}
          />
          Trust this device for 30 days
        </label>
        <p className="-mt-2 text-xs text-muted">
          Only on a device that is yours. Not on a shared clinic workstation.
        </p>

        <Button type="submit" loading={busy}>
          Verify
        </Button>
      </form>

      <button
        type="button"
        className="mt-4 text-sm text-muted underline underline-offset-4"
        onClick={() => {
          setMode(mode === "totp" ? "recovery" : "totp");
          setCode("");
          setError(null);
        }}
      >
        {mode === "totp"
          ? "Use a recovery code instead"
          : "Use my authenticator app"}
      </button>
    </Card>
  );
}
