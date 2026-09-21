"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import { Alert, Button, Card } from "./ui";
import { PasswordField } from "./password-field";

/**
 * Shared by the invitation link and the reset link: the flow is identical, only
 * the wording differs.
 */
export function SetPasswordForm({
  title,
  description,
  cta,
}: {
  title: string;
  description: string;
  cta: string;
}) {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <Card title={title}>
        <Alert>
          This link is incomplete. Open the most recent link from your email, or
          ask your administrator for a new one.
        </Alert>
      </Card>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setServerMessage(null);
    try {
      await api("/auth/password/reset", {
        method: "POST",
        body: { token, password },
      });
      setDone(true);
      setTimeout(() => router.replace("/login"), 1200);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "password_rejected") {
        setServerMessage(caught.message);
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError("Cannot reach the server.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card title="Password set">
        <Alert tone="success">
          Your password is saved and every other session has been signed out.
          Taking you to the sign in page.
        </Alert>
      </Card>
    );
  }

  return (
    <Card title={title} description={description}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <PasswordField
          value={password}
          onChange={setPassword}
          serverMessage={serverMessage}
        />
        <Button type="submit" loading={busy} disabled={password.length < 12}>
          {cta}
        </Button>
        <p className="text-xs text-muted">
          Setting a password signs out every other device you are signed in on.
        </p>
      </form>
    </Card>
  );
}
