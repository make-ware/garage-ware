'use client';

import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CLUSTER_PANEL_CLASS } from '@/components/cluster/panel';
import { GARAGE_HOME_URL } from '@/lib/garage-docs';

/**
 * The user-facing half of "this deployment cannot reach its cluster".
 *
 * `/dashboard/cluster` is a redacted projection for every signed-in user, so
 * this says nothing an operator would say: no env var names, no admin doc
 * links, no admin token talk. `garageErrorResponse()` writes two 502/503 bodies
 * addressed *to an administrator* (`lib/auth/server.ts`), and the page used to
 * render whatever it caught verbatim — this notice is what replaces it.
 *
 * No "your data is safe" reassurance either: the admin API being unreachable
 * says nothing reliable about the S3 gateway, and a false reassurance is worse
 * than none.
 *
 * Separate from `components/setup/no-cluster-card.tsx` on purpose — see the
 * note there.
 */
export function ClusterUnavailableNotice() {
  return (
    <Card className={CLUSTER_PANEL_CLASS}>
      <CardHeader>
        <CardTitle>Cluster unavailable</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          This console manages a Garage storage cluster. It cannot reach that
          cluster right now, so the node map and layout are unavailable. If this
          does not clear up, ask your administrator to check the cluster.
        </p>
        <p>
          <a
            href={GARAGE_HOME_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline hover:text-foreground"
          >
            What is Garage?
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
