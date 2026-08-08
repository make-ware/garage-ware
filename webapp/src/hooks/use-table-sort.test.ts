import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTableSort } from './use-table-sort';

interface Row {
  name: string;
  bytes?: number;
}

const ROWS: Row[] = [
  { name: 'charlie', bytes: 30 },
  { name: 'alpha', bytes: 10 },
  { name: 'bravo', bytes: 20 },
];

const ACCESSORS = {
  name: (r: Row) => r.name,
  bytes: (r: Row) => r.bytes,
} as const;

function setup(rows: Row[] = ROWS) {
  return renderHook(() =>
    useTableSort<Row, keyof typeof ACCESSORS>(rows, ACCESSORS, {
      key: 'name',
      direction: 'asc',
    })
  );
}

describe('useTableSort', () => {
  it('sorts by the initial key ascending', () => {
    const { result } = setup();
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  it('toggles direction when the same key is clicked again', () => {
    const { result } = setup();
    act(() => result.current.toggle('name'));
    expect(result.current.sort.direction).toBe('desc');
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      'charlie',
      'bravo',
      'alpha',
    ]);
  });

  it('starts a newly clicked column ascending', () => {
    const { result } = setup();
    act(() => result.current.toggle('name')); // now desc
    act(() => result.current.toggle('bytes'));
    expect(result.current.sort).toEqual({ key: 'bytes', direction: 'asc' });
    expect(result.current.sorted.map((r) => r.bytes)).toEqual([10, 20, 30]);
  });

  it('compares numbers numerically, not lexically', () => {
    const { result } = setup([
      { name: 'a', bytes: 9 },
      { name: 'b', bytes: 100 },
    ]);
    act(() => result.current.toggle('bytes'));
    expect(result.current.sorted.map((r) => r.bytes)).toEqual([9, 100]);
  });

  it('sorts missing values last in BOTH directions', () => {
    // A bucket whose Garage usage fetch failed has no byte count. Floating it
    // to the top of "least used" would read as "this bucket is empty".
    const rows: Row[] = [
      { name: 'a', bytes: 10 },
      { name: 'b' },
      { name: 'c', bytes: 30 },
    ];
    const { result } = setup(rows);

    act(() => result.current.toggle('bytes')); // asc
    expect(result.current.sorted.map((r) => r.name)).toEqual(['a', 'c', 'b']);

    act(() => result.current.toggle('bytes')); // desc
    expect(result.current.sorted.map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const rows = [...ROWS];
    const snapshot = rows.map((r) => r.name);
    setup(rows);
    expect(rows.map((r) => r.name)).toEqual(snapshot);
  });
});
