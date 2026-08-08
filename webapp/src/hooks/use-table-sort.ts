'use client';

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export type SortAccessors<T, K extends string> = Record<
  K,
  (row: T) => string | number | null | undefined
>;

/**
 * Client-side sort for a table whose rows all arrive in one response.
 *
 * `/next-api/garage/buckets?all=true` serves a single 200-row page with no sort
 * parameter, so sorting has to happen here. If that endpoint ever grows
 * pagination, this hook must be *replaced* by a server-side sort rather than
 * wrapped around one — sorting a page is not sorting a list.
 *
 * Pass `accessors` from module scope or a `useMemo`; an inline object literal is
 * a new reference on every render and would defeat the memo below.
 */
export function useTableSort<T, K extends string>(
  rows: T[],
  accessors: SortAccessors<T, K>,
  initial: { key: K; direction: SortDirection }
) {
  const [sort, setSort] = useState(initial);

  // A newly clicked column always starts ascending, so the control stays
  // predictable rather than guessing that numbers "probably" want descending.
  const toggle = useCallback((key: K) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    );
  }, []);

  const sorted = useMemo(() => {
    const read = accessors[sort.key];
    if (!read) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    // Copy first: Array.prototype.sort mutates, and `rows` is state we borrow.
    return [...rows].sort((a, b) => {
      const av = read(a);
      const bv = read(b);
      const aMissing = av === null || av === undefined || av === '';
      const bMissing = bv === null || bv === undefined || bv === '';
      // Missing sorts LAST in both directions — note the deliberate absence of
      // `factor`. A bucket whose Garage usage fetch failed has no byte count,
      // and floating it to the top of "least used" would read as "this bucket
      // is empty", which is the one thing we do not know about it.
      if (aMissing || bMissing) {
        return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return factor * (av - bv);
      }
      return (
        factor *
        String(av).localeCompare(String(bv), undefined, { numeric: true })
      );
    });
  }, [rows, sort, accessors]);

  return { sorted, sort, toggle };
}
