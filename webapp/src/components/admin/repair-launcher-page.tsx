'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RepairNodeTable } from '@/components/admin/repair-node-table';
import { useRepairData } from '@/hooks/use-repair-data';
import type { RepairAction } from '@/lib/repair/operations';
import { formatPbDateTime } from '@/lib/format';

interface Props {
  action: RepairAction;
  title: string;
  description: React.ReactNode;
  describe: (nodeLabel: string) => React.ReactNode;
}

/**
 * The whole of a status-less repair page: blocks and rebalance differ only in
 * their copy, so they pass it in rather than each keeping a copy of this shell.
 */
export function RepairLauncherPage({
  action,
  title,
  description,
  describe,
}: Props) {
  const { rows, loading, error, workersUnavailable, fetchedAt, refresh } =
    useRepairData();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {description}
            {fetchedAt && (
              <> Worker state read {formatPbDateTime(fetchedAt)}.</>
            )}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="gap-1.5 shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {error && <p className="text-destructive mb-4">{error}</p>}
        {workersUnavailable && (
          <p className="text-muted-foreground mb-4 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Could not read worker state from the cluster. Repair actions still
            work.
          </p>
        )}
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No nodes in the cluster layout.
          </p>
        ) : (
          <RepairNodeTable
            action={action}
            rows={rows}
            describe={describe}
            onLaunched={handleRefresh}
          />
        )}
      </CardContent>
    </Card>
  );
}
