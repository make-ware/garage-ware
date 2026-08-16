'use client';

import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
// One implementation of the shape and of the copy-for-support text; see the
// note in that file about why it is not `server-only`.
import type { Check, CheckState, Diagnostics } from '@/lib/setup/diagnostics';

export type { Check, CheckState, Diagnostics };
export { formatDiagnostics } from '@/lib/setup/diagnostics';

const PRESENTATION: Record<
  CheckState,
  { icon: typeof CheckCircle2; tone: string; word: string }
> = {
  ok: { icon: CheckCircle2, tone: 'text-emerald-500', word: 'OK' },
  warn: {
    icon: TriangleAlert,
    tone: 'text-amber-500',
    word: 'Needs attention',
  },
  fail: { icon: AlertCircle, tone: 'text-destructive', word: 'Not working' },
  unknown: { icon: HelpCircle, tone: 'text-muted-foreground', word: 'Unknown' },
};

export function StatusChecks({ checks }: { checks: Check[] }) {
  return (
    <ul className="divide-y rounded-md border">
      {checks.map((check) => {
        const { icon: Icon, tone, word } = PRESENTATION[check.state];
        return (
          <li key={check.id} className="flex gap-3 p-4">
            <Icon
              className={cn('mt-0.5 h-5 w-5 shrink-0', tone)}
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{check.label}</span>
                <span className={cn('text-xs', tone)}>{word}</span>
              </div>
              <p className="text-sm text-muted-foreground">{check.detail}</p>
              {check.hint && (
                <p className="text-sm">
                  <span className="text-muted-foreground">→ </span>
                  {check.hint}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
