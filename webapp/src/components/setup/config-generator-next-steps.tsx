'use client';

import { ExternalLink } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DOC_LINKS,
  NEXT_STEPS,
  NO_INSTALL_NOTICE,
} from '@/lib/garage-config/garage-toml-copy';

/**
 * What to do with the file, from downloading it to a connected deployment.
 *
 * The arc deliberately ends on `GARAGE_ADMIN_URL` / `GARAGE_ADMIN_TOKEN` —
 * the same pair `NoClusterCard` names on `/admin/status`, which is where an
 * operator with no cluster started. This page is the missing rung between
 * them, so it hands them back rather than trailing off.
 *
 * The commands are text to copy, not buttons. garage-ware cannot run them:
 * they happen on hosts it has no connection to, which is the whole reason
 * this page generates a file instead of provisioning anything.
 */
export function ConfigGeneratorNextSteps() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Next steps</CardTitle>
        <CardDescription>{NO_INSTALL_NOTICE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="space-y-5">
          {NEXT_STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span
                className="bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-muted-foreground text-sm">{step.body}</p>
                {step.command && (
                  <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
                    {step.command}
                  </pre>
                )}
              </div>
            </li>
          ))}
        </ol>

        <ul className="space-y-1 border-t pt-4">
          {DOC_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm underline hover:text-foreground"
              >
                {link.label}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
