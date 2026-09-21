"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALLERGY_BADGE,
  ApiError,
  SEX_LABEL,
  api,
  type SearchHit,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import { Icon } from "@/components/icons";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Spinner,
  timeAgo,
} from "@/components/ui";

/**
 * Reception's home screen, and the most-used page in the product.
 *
 * A receptionist runs this several hundred times a day with someone standing
 * in front of them, so everything here is in service of that: the box takes
 * focus on load and on `/`, results arrive as they type, and the keyboard
 * alone is enough to get from an empty box to an open record.
 */
/** A key on the keyboard, drawn as one. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-sunken px-1.5 py-0.5 font-sans text-[11px] text-muted shadow-e1">
      {children}
    </kbd>
  );
}

export default function PatientsPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useAsyncEffect(async () => {
    try {
      const response = await api<{ items: SearchHit[] }>("/patients/recent");
      setRecent(response.items);
    } catch {
      // A missing recent list is not worth an error message.
    }
  }, []);

  const run = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      // A POST for a read, because the text is very often an identity card
      // number and those must not appear in a URL (PAT-N-06).
      const response = await api<{ items: SearchHit[] }>("/patients/search", {
        method: "POST",
        body: { q },
      });
      setHits(response.items);
      setSelected(0);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Cannot reach the server.",
      );
    } finally {
      setSearching(false);
    }
  }, [query]);

  // Search as they type, without a request per keystroke.
  useAsyncEffect(() => run(), [run], { debounceMs: 150 });

  // `/` puts the cursor back in the box from anywhere on the page, which is
  // what someone who never touches the mouse expects.
  useEffect(() => {
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== box.current) {
        event.preventDefault();
        box.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = hits ?? (query.trim().length < 2 ? recent : []);
  const showingRecent =
    hits === null && query.trim().length < 2 && recent.length > 0;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((n) => Math.min(n + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((n) => Math.max(n - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = shown[selected];
      if (hit) router.push(`/patients/${hit.id}`);
    } else if (event.key === "Escape") {
      setQuery("");
      setHits(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Patients"
        description="Search by name, patient number, the last four of an identity card, or a telephone number in any format."
        actions={
          <Button
            onClick={() =>
              router.push(
                `/patients/new${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
              )
            }
          >
            <Icon name="plus" className="size-4" />
            Register a patient
          </Button>
        }
      />

      <Card padding="tight">
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-soft"
          >
            <Icon name="search" />
          </span>
          <Input
            ref={box}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Start typing a name, a number, or a telephone"
            aria-label="Search for a patient"
            className="h-12 pl-11 text-base"
            autoComplete="off"
          />
          {searching && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-soft">
              <Spinner />
            </span>
          )}
        </div>
        <p className="mt-2 text-[13px] text-muted">
          <Kbd>/</Kbd> comes back here from anywhere · <Kbd>↑</Kbd> <Kbd>↓</Kbd>{" "}
          to move · <Kbd>Enter</Kbd> to open · <Kbd>Esc</Kbd> to clear
        </p>
      </Card>

      {error && <Alert title="Search failed">{error}</Alert>}

      {showingRecent && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Recently opened here
        </h2>
      )}

      {hits !== null && hits.length > 0 && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {hits.length === 20
            ? "First 20 matches"
            : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
        </h2>
      )}

      {shown.length === 0 && !searching && query.trim().length >= 2 && (
        <EmptyState
          title={`Nobody matches "${query.trim()}"`}
          actions={
            <Button
              onClick={() =>
                router.push(
                  `/patients/new?q=${encodeURIComponent(query.trim())}`,
                )
              }
            >
              Register {query.trim()}
            </Button>
          }
        >
          Check the spelling, or try the telephone number instead.
        </EmptyState>
      )}

      {shown.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-e1">
          {shown.map((hit, index) => (
            <li key={hit.id}>
              <Link
                href={`/patients/${hit.id}`}
                onMouseEnter={() => setSelected(index)}
                className={`flex items-center gap-4 px-4 py-3 transition-colors ${
                  index === selected
                    ? "bg-primary-soft"
                    : "hover:bg-surface-muted"
                }`}
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-muted"
                >
                  {hit.name.slice(0, 2).toUpperCase()}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{hit.name}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {[
                      hit.mrn,
                      hit.idNumberMasked,
                      [hit.age, SEX_LABEL[hit.gender]]
                        .filter(Boolean)
                        .join(" "),
                      hit.phone,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>

                {/* The allergy state is the one thing worth seeing before
                    the record opens, so it keeps its own colour rather
                    than becoming another grey chip. */}
                <span
                  className={`hidden shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold sm:inline ${
                    ALLERGY_BADGE[hit.allergyState].tone
                  }`}
                >
                  {hit.allergyState === "SOME" || hit.allergyState === "SEVERE"
                    ? `${hit.allergyCount} allergy${hit.allergyCount === 1 ? "" : " records"}`
                    : ALLERGY_BADGE[hit.allergyState].label}
                </span>

                <span className="hidden w-24 shrink-0 text-right text-[13px] text-muted lg:block">
                  {hit.lastVisitAt ? timeAgo(hit.lastVisitAt) : "No visits"}
                </span>

                <span aria-hidden className="shrink-0 text-muted-soft">
                  <Icon name="chevronRight" className="size-4" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hits !== null && hits.length === 20 && (
        <p className="text-[13px] text-muted">
          Only the first twenty are shown. Add the telephone number or the last
          four of the identity card to narrow it down.
        </p>
      )}
    </div>
  );
}
