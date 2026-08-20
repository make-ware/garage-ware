'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Info, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LayoutHistoryCard } from '@/components/cluster/layout-history-card';
import { StagedChangesTable } from '@/components/cluster/staged-changes-table';
import { StagingCurrentTable } from '@/components/cluster/staging-current-table';
import { StagingForm } from '@/components/cluster/staging-form';
import { StagingNextSteps } from '@/components/cluster/staging-next-steps';
import { api, ApiError } from '@/lib/api-client';
import { GARAGE_LAYOUT_DOC_URL } from '@/lib/garage-docs';
import {
  CONFLICT_COPY,
  STAGED_PARAMETERS_COPY,
  STAGE_ONLY_NOTICE,
} from '@/lib/cluster/staging-copy';
import type { StageChangeRequest, StagingPayload } from '@/lib/admin-types';

const STAGING_PATH = '/next-api/garage/cluster/staging';

const fetchStaging = () => api<StagingPayload>(STAGING_PATH);

/**
 * Cluster layout staging: change a node's role on the real cluster, and stop.
 *
 * The planner next door answers "what would this do"; this page acts on the
 * answer — and goes exactly as far as `UpdateClusterLayout`. **garage-ware
 * stages; a human applies.** `ApplyClusterLayout`, `RevertClusterLayout` and
 * `ClusterLayoutSkipDeadNodes` are not wired anywhere in the app, and
 * `cluster/staging-boundary.test.ts` fails the build if they ever are. Staging
 * cannot move a byte; applying moves all of them, for hours, with no undo.
 *
 * **The conflict check is this app's, not Garage's.** `UpdateClusterLayout`
 * takes no version and no CAS parameter — it merges whatever it is sent into
 * whatever is already staged — so the page echoes back the layout version and a
 * fingerprint of the staging area, and the route refuses on a mismatch. A 409
 * is **never retried**: it gets its own alert and a Refresh button, because the
 * only safe next step is for a human to look at what is staged now.
 */
export default function ClusterStagingPage() {
  const [data, setData] = useState<StagingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fetched = await fetchStaging();
      setData(fetched);
      setError(null);
      setConflict(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load cluster layout'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const fetched = await fetchStaging();
        if (!cancelled) {
          setData(fetched);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load cluster layout'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const stage = async (change: StageChangeRequest) => {
    if (!data || submitting) return;
    setSubmitting(true);
    setConflict(null);
    try {
      // POST answers with the refreshed layout — UpdateClusterLayout returns a
      // full GetClusterLayoutResponse, so there is nothing to refetch.
      const next = await api<StagingPayload>(STAGING_PATH, {
        method: 'POST',
        body: {
          expectedVersion: data.version,
          expectedStagedFingerprint: data.stagedFingerprint,
          changes: [change],
        },
      });
      setData(next);
      setError(null);
      toast.success('Change staged — apply it on a cluster host');
      if (next.logged === false) {
        toast.warning('Staged, but the timeline entry could not be written');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // No auto-retry, deliberately: retrying would stage against a layout
        // nobody has looked at.
        setConflict(err.message);
        return;
      }
      const message = err instanceof Error ? err.message : 'Staging failed';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Alert>
        <Info />
        <AlertTitle>garage-ware stages. You apply.</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{STAGE_ONLY_NOTICE}</p>
          <p>
            Work the numbers out on the{' '}
            <Link href="/admin/cluster/planner">layout planner</Link> first.
            Garage&rsquo;s own{' '}
            <a
              href={GARAGE_LAYOUT_DOC_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              layout operations guide
            </a>{' '}
            documents every command below.
          </p>
        </AlertDescription>
      </Alert>

      {conflict && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Nothing was staged</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{conflict}</p>
            <p>{CONFLICT_COPY}</p>
            <Button size="sm" variant="outline" onClick={load}>
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The cluster could not be reached</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !data ? (
        <p className="text-muted-foreground text-sm">Loading layout…</p>
      ) : data ? (
        <>
          {data.stagedParametersPending && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Layout parameters are staged too</AlertTitle>
              <AlertDescription>{STAGED_PARAMETERS_COPY}</AlertDescription>
            </Alert>
          )}

          <StagedChangesTable roles={data.roles} staged={data.staged} />

          {data.staged.length > 0 && (
            <StagingNextSteps version={data.version} />
          )}

          <StagingForm
            candidates={data.candidates}
            roles={data.roles}
            staged={data.staged}
            submitting={submitting}
            onStage={stage}
          />

          <StagingCurrentTable roles={data.roles} version={data.version} />

          <LayoutHistoryCard />
        </>
      ) : null}
    </div>
  );
}
