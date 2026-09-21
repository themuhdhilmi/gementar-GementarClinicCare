"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import { Alert, Button, Input } from "@/components/ui";

type LoginResponse = {
  mfaRequired: boolean;
  mfaEnrolmentRequired: boolean;
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  // While rate limited, count down rather than leaving someone to guess.
  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setLockedUntil(null);
        setError(null);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lockedUntil !== null) return;
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      const result = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      if (result.mfaEnrolmentRequired) router.replace("/enrol-mfa");
      else if (result.mfaRequired) router.replace("/mfa");
      else router.replace("/workspace");
    } catch (caught) {
      if (caught instanceof ApiError) {
        // The server answers the same way for a wrong password, an unknown
        // address and a locked account. Do not embellish it here.
        setError(caught.message);
        if (caught.code === "rate_limited") {
          const seconds = (
            caught.problem.errors as { retryAfter?: number } | undefined
          )?.retryAfter;
          if (seconds) setLockedUntil(Date.now() + seconds * 1000);
        }
        // An unreachable database is not the person's mistake, so leave what
        // they typed in place and let them press the button again.
        setUnavailable(caught.code === "database_unavailable");
        if (caught.code !== "database_unavailable") setPassword("");
      } else {
        setError(
          "Cannot reach the server. Check the connection and try again.",
        );
        setUnavailable(true);
      }
    } finally {
      setBusy(false);
    }
  }

  const throttled = lockedUntil !== null;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-sm text-muted">
        Use the account your clinic administrator created for you.
      </p>

      <form onSubmit={submit} className="mt-7 flex flex-col gap-4" noValidate>
        {error && (
          <Alert tone={throttled || unavailable ? "warning" : "danger"}>
            {error}
            {throttled && remaining > 0 && (
              <>
                {" "}
                Try again in{" "}
                <strong className="tabular-nums">
                  {formatCountdown(remaining)}
                </strong>
                .
              </>
            )}
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            ref={emailRef}
            required
            autoComplete="username"
            inputMode="email"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="you@clinic.my"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-11"
          />
        </div>

        {/* The forgot link sits in the label row visually, but comes after the
            field in the markup: tabbing from email must land on the password
            box, not on a link. */}
        <div className="relative flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>

          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyUp={(event) =>
                setCapsLock(event.getModifierState("CapsLock"))
              }
              onKeyDown={(event) =>
                setCapsLock(event.getModifierState("CapsLock"))
              }
              onBlur={() => setCapsLock(false)}
              className="h-11 pr-20"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-muted hover:text-foreground"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>

          <Link
            href="/forgot-password"
            className="absolute right-0 top-0 text-sm text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            Forgot password?
          </Link>

          {capsLock && (
            <p className="text-xs text-warning" role="status">
              Caps Lock is on.
            </p>
          )}
        </div>

        <Button
          type="submit"
          loading={busy}
          disabled={throttled}
          className="mt-1 h-11"
        >
          {throttled ? `Locked for ${formatCountdown(remaining)}` : "Sign in"}
        </Button>
      </form>

      <p className="mt-8 border-t border-line pt-5 text-xs leading-relaxed text-muted">
        Every clinical record is attributed to whoever is signed in, so never
        sign in as a colleague. If you think someone else knows your password,
        change it and tell your administrator.
      </p>
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0
    ? `${minutes}:${String(rest).padStart(2, "0")}`
    : `${rest}s`;
}
