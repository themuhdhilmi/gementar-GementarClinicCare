"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { DisplayView } from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import { useQueueStream } from "@/lib/use-queue-stream";
import { Logo } from "@/components/logo";

/**
 * The screen on the waiting-room wall (ENC-F-20).
 *
 * Outside the signed-in part of the application on purpose: it has no
 * session, it authenticates with the token in its own address, and it shows
 * queue numbers and nothing that identifies anybody (ENC-R-10).
 *
 * It is designed for a television across a room, so the numerals are
 * enormous and the contrast is high. It has to run unattended for twelve
 * hours (ENC-N-04), which is why nothing here accumulates: the view is
 * replaced wholesale on each refresh, the clock is one interval, and the
 * connection reconnects by itself.
 */
export default function DisplayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [view, setView] = useState<DisplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState("");
  const lastCalled = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/display/${token}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setError(
          response.status === 404
            ? "This screen is no longer connected to a clinic. Ask for a new address."
            : "Cannot reach the clinic system.",
        );
        return;
      }
      setView((await response.json()) as DisplayView);
      setError(null);
    } catch {
      setError("Cannot reach the clinic system.");
    }
  }, [token]);

  useAsyncEffect(() => load(), [load]);

  useQueueStream(`/api/v1/display/${token}/stream`, () => void load());

  // A slow poll behind the live feed. If the connection dies in a way the
  // browser does not notice, a screen showing yesterday's queue is worse
  // than one that is a minute behind.
  useEffect(() => {
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * A chime when a new number is called.
   *
   * Built with the Web Audio API rather than an audio file: it is two
   * notes, and a browser that has not been interacted with will refuse to
   * play anything at all, so a missing file would be indistinguishable from
   * a blocked one. Failures are swallowed, because a silent screen is still
   * a working screen.
   */
  useEffect(() => {
    const top = view?.recentlyCalled[0];
    if (!top) return;
    const key = `${top.queueNo}-${top.at}`;
    if (lastCalled.current === null) {
      lastCalled.current = key;
      return;
    }
    if (lastCalled.current === key) return;
    lastCalled.current = key;

    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      const audio = new Ctor();
      for (const [index, frequency] of [880, 1174].entries()) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        gain.connect(audio.destination);
        const at = audio.currentTime + index * 0.18;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
        oscillator.start(at);
        oscillator.stop(at + 0.4);
      }
      setTimeout(() => void audio.close().catch(() => undefined), 1500);
    } catch {
      // Audio is blocked until somebody touches the screen. Not a fault.
    }
  }, [view]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black p-8 text-center">
        <p className="text-3xl text-white">{error}</p>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black">
        <p className="text-3xl text-white/60">Connecting…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black px-8 py-6 text-white">
      <header className="flex items-center justify-between gap-6 border-b border-white/20 pb-4">
        <div className="flex items-center gap-5">
          <Logo className="h-10 w-auto" surface="dark" compact priority />
          <h1 className="text-3xl font-semibold">{view.branch.name}</h1>
        </div>
        <span className="text-3xl tabular-nums text-white/70">{clock}</span>
      </header>

      <section className="mt-8">
        <h2 className="text-xl uppercase tracking-widest text-white/50">
          Now serving
        </h2>
        {view.nowServing.length === 0 ? (
          <p className="mt-6 text-4xl text-white/40">Please wait</p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {view.nowServing.map((row) => {
              // The number called most recently is the one somebody is
              // standing up for. It gets the brand colour; the rest stay
              // quiet, so there is exactly one thing to look at.
              const justCalled =
                row.queueNo === view.recentlyCalled[0]?.queueNo;
              return (
                <li
                  key={row.queueNo}
                  className={
                    justCalled
                      ? "rounded-2xl bg-primary px-6 py-5 text-on-primary ring-4 ring-primary/40"
                      : "rounded-2xl bg-white/10 px-6 py-5 ring-1 ring-white/20"
                  }
                >
                  {/* 60px+ numerals: readable from the far side of the room. */}
                  <p className="text-7xl font-bold tabular-nums leading-none">
                    {row.queueNo}
                  </p>
                  {row.label && (
                    <p
                      className={`mt-2 truncate text-2xl ${
                        justCalled ? "text-on-primary/90" : "text-white/80"
                      }`}
                    >
                      {row.label}
                    </p>
                  )}
                  <p
                    className={`mt-1 text-xl uppercase tracking-wide ${
                      justCalled ? "text-on-primary/70" : "text-white/50"
                    }`}
                  >
                    {row.where}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10 grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div>
          <h2 className="text-xl uppercase tracking-widest text-white/50">
            Waiting · {view.waitingCount}
          </h2>
          <ul className="mt-4 flex flex-wrap gap-3">
            {view.waiting.map((row) => (
              <li
                key={row.queueNo}
                className="rounded-xl bg-white/5 px-5 py-3 text-4xl font-semibold tabular-nums"
              >
                {row.queueNo}
                {row.label && (
                  <span className="ml-3 align-middle text-xl font-normal text-white/60">
                    {row.label}
                  </span>
                )}
              </li>
            ))}
            {view.waiting.length === 0 && (
              <li className="text-3xl text-white/40">Nobody waiting</li>
            )}
          </ul>
        </div>

        <div>
          <h2 className="text-xl uppercase tracking-widest text-white/50">
            Just called
          </h2>
          <ul className="mt-4 flex flex-col gap-2">
            {view.recentlyCalled.map((row) => (
              <li
                key={`${row.queueNo}-${row.at}`}
                className="flex items-baseline gap-3 text-2xl"
              >
                <span className="font-semibold tabular-nums">
                  {row.queueNo}
                </span>
                <span className="text-white/50">{row.where}</span>
              </li>
            ))}
            {view.recentlyCalled.length === 0 && (
              <li className="text-xl text-white/40">Nothing yet today</li>
            )}
          </ul>
        </div>
      </section>
    </main>
  );
}
