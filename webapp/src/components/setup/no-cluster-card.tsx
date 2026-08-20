'use client';

import { ExternalLink } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { GARAGE_ADMIN_DOC_LINKS } from '@/lib/garage-docs';

/**
 * Shown below the deployment checks when `needsClusterSetup()` says this
 * deployment cannot reach a cluster at all.
 *
 * Admin-facing: it names the two env vars, because the audience is whoever
 * deployed the container. The user-facing equivalent is
 * `components/cluster/cluster-unavailable.tsx`, which shares no code with this
 * on purpose — one component with a `variant` prop is how an admin doc link
 * eventually renders to a regular user.
 *
 * Deliberately does **not** repeat `garage admin-token create --name
 * garage-ware`: that already lives in the failing check's own hint, rendered
 * directly above this card, and two copies of a command drift.
 */
export function NoClusterCard() {
  return (
    <Card className="mt-6 border-dashed">
      <CardHeader>
        <CardTitle>No cluster yet?</CardTitle>
        <CardDescription>
          garage-ware manages an existing GarageHQ cluster — it does not install
          one. Install and configure GarageHQ first, then point this deployment
          at it by setting <code className="font-mono">GARAGE_ADMIN_URL</code>{' '}
          and <code className="font-mono">GARAGE_ADMIN_TOKEN</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-3">
          {GARAGE_ADMIN_DOC_LINKS.map((link) => (
            <li key={link.href} className="space-y-1">
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium underline hover:text-foreground"
              >
                {link.title}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              <p className="text-sm text-muted-foreground">{link.blurb}</p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          These are Garage&apos;s own docs. garage-ware does not install, run or
          store credentials for a cluster.
        </p>
      </CardContent>
    </Card>
  );
}
