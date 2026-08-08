'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { SortDirection } from '@/hooks/use-table-sort';

/**
 * A table header cell that sorts on click.
 *
 * `aria-sort` belongs on the header *cell*, not on the control inside it, so it
 * lives on `TableHead` while the button carries the label and the icon.
 */
export function SortableTableHead({
  active,
  direction,
  onSort,
  className,
  children,
}: {
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const Icon = !active
    ? ChevronsUpDown
    : direction === 'asc'
      ? ArrowUp
      : ArrowDown;

  return (
    <TableHead
      className={className}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'inline-flex items-center gap-1 -mx-1 px-1 rounded hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none',
          !active && 'text-muted-foreground'
        )}
      >
        {children}
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
    </TableHead>
  );
}
