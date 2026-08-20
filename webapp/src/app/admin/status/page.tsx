'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardCopy, FileCog, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  formatDiagnostics,
  needsClusterSetup,
  NoClusterCard,
  StatusChecks,
  type Diagnostics,
} from '@/components/setup/status-checks';
import { api } from '@/lib/api-client';

const OVERALL_COPY: Record<Diagnostics['overall'], string> = {
  ok: 'Everything this deployment depends on is working.',
  warn: 'This deployment works, but some features are degraded or disabled.',
  fail: 'Something this deployment depends on is not working.',
  unknown: 'Some checks could not be completed.',
};

export default function AdminStatusPage() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<Diagnostics>('/next-api/status');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Inner async fn + cancel flag: no setState in the effect body.
    let cancelled = false;
    const run = async () => {
      try {
        const result = await api<Diagnostics>('/next-api/status');
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Could not load status'
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

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(formatDiagnostics(data));
      toast.success('Diagnostics copied');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Status</h1>
          <p className="mt-1 text-muted-foreground">
            What this deployment can and cannot currently do.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={copy}
            disabled={!data}
            title="Copy a redacted summary for a bug report"
          >
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`}
            />
            Re-run
          </Button>
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Deployment checks</CardTitle>
          <CardDescription>
            {data
              ? OVERALL_COPY[data.overall]
              : loading
                ? 'Running checks…'
                : 'No results.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data ? (
            <StatusChecks checks={data.checks} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {loading ? 'Checking…' : '—'}
            </p>
          )}
        </CardContent>
      </Card>

      {data && needsClusterSetup(data.checks) && (
        <>
          <NoClusterCard />
          {/*
            Deliberately beside the card and not inside it: `NoClusterCard` is
            also rendered by `/setup` step 3, which is reachable before anyone
            is an admin, and `/admin/setup/config-generator` is admin-only.
            One component with a `variant` prop is how an admin-only link
            eventually renders to a regular user.
          */}
          <Card className="mt-4 border-dashed">
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
              <div>
                <p className="text-sm font-medium">
                  Starting from nothing at all?
                </p>
                <p className="text-muted-foreground text-sm">
                  Generate a <code className="font-mono">garage.toml</code> to
                  place on each node, then come back and set the two variables
                  above.
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/setup/config-generator">
                  <FileCog className="mr-2 h-4 w-4" />
                  Config generator
                </Link>
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {data && (
        <p className="mt-4 text-xs text-muted-foreground">
          Generated {new Date(data.generatedAt).toLocaleString()}. Values of
          secret environment variables are never included here or in the copied
          summary.
        </p>
      )}
    </div>
  );
}
