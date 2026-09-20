'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALLERGY_BADGE,
  ApiError,
  SEX_LABEL,
  api,
  type SearchHit,
} from '@/lib/api';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Button, EmptyState, Input, timeAgo } from '@/components/ui';

/**
 * Reception's home screen, and the most-used page in the product.
 *
 * A receptionist runs this several hundred times a day with someone standing
 * in front of them, so everything here is in service of that: the box takes
 * focus on load and on `/`, results arrive as they type, and the keyboard
 * alone is enough to get from an empty box to an open record.
 */
export default function PatientsPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useAsyncEffect(async () => {
    try {
      const response = await api<{ items: SearchHit[] }>('/patients/recent');
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
      const response = await api<{ items: SearchHit[] }>('/patients/search', {
        method: 'POST',
        body: { q },
      });
      setHits(response.items);
      setSelected(0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Cannot reach the server.');
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
      if (event.key === '/' && document.activeElement !== box.current) {
        event.preventDefault();
        box.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = hits ?? (query.trim().length < 2 ? recent : []);
  const showingRecent = hits === null && query.trim().length < 2 && recent.length > 0;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((n) => Math.min(n + 1, shown.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((n) => Math.max(n - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = shown[selected];
      if (hit) router.push(`/patients/${hit.id}`);
    } else if (event.key === 'Escape') {
      setQuery('');
      setHits(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Patients</h1>
        <Button
          onClick={() =>
            router.push(`/patients/new${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
          }
        >
          Register a new patient
        </Button>
      </div>

      <div>
        <Input
          ref={box}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Name, patient number, last 4 of IC, or telephone"
          aria-label="Search for a patient"
          className="h-12 text-base"
          autoComplete="off"
        />
        <p className="mt-1.5 text-sm text-muted">
          Press <kbd className="rounded border border-line px-1">/</kbd> to come back here,
          arrows to move, <kbd className="rounded border border-line px-1">Enter</kbd> to open.
        </p>
      </div>

      {error && <Alert title="Search failed">{error}</Alert>}

      {showingRecent && (
        <p className="text-sm font-medium text-muted">Recently opened here</p>
      )}

      {shown.length === 0 && !searching && query.trim().length >= 2 && (
        <EmptyState title={`Nobody matches "${query.trim()}"`}>
          Check the spelling, try the telephone number, or register them as a new patient.
        </EmptyState>
      )}

      {shown.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {shown.map((hit, index) => (
            <li key={hit.id}>
              <Link
                href={`/patients/${hit.id}`}
                onMouseEnter={() => setSelected(index)}
                className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${
                  index === selected ? 'bg-primary-soft' : 'hover:bg-surface-muted'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{hit.name}</span>
                  <span className="block text-sm text-muted">
                    {[
                      hit.mrn,
                      hit.idNumberMasked,
                      [hit.age, SEX_LABEL[hit.gender]].filter(Boolean).join(' '),
                      hit.phone,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    ALLERGY_BADGE[hit.allergyState].tone
                  }`}
                >
                  {hit.allergyState === 'SOME' || hit.allergyState === 'SEVERE'
                    ? `${hit.allergyCount} allergy${hit.allergyCount === 1 ? '' : ' records'}`
                    : ALLERGY_BADGE[hit.allergyState].label}
                </span>
                <span className="w-28 shrink-0 text-right text-sm text-muted">
                  {hit.lastVisitAt ? timeAgo(hit.lastVisitAt) : 'No visits'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hits !== null && hits.length === 20 && (
        <p className="text-sm text-muted">
          Showing the first twenty. Add the telephone number or the last four of the identity
          card to narrow it down.
        </p>
      )}
    </div>
  );
}
