'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { applyCommands } from '@/lib/cluster/staged-changes';
import {
  APPLY_ONCE_WARNING,
  NO_UNSTAGE_NOTICE,
} from '@/lib/cluster/staging-copy';

/**
 * What to run, now that something is staged.
 *
 * **Expanded by default**, unlike `PlannerCommands`. There the plan was the
 * answer and the commands were how to act on it; here the command *is* the
 * answer — the page has already made the change it can make, and everything
 * left is on a cluster host.
 *
 * The version number is not decoration: `garage layout apply` requires the
 * version it will produce, which is the current one plus one. Naming it is what
 * makes a second, accidental apply fail rather than bump the layout again — so
 * it is computed once, in `applyCommands`, and this component never formats it
 * itself.
 *
 * `garage layout revert` appears in prose **outside** the copy block, on
 * purpose: it is the manual escape hatch, it is not an undo, and it must not be
 * something a hurried operator pastes along with everything else.
 */
export function StagingNextSteps({ version }: { version: number }) {
  const commands = applyCommands(version);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands.join('\n'));
      toast.success('Commands copied');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Next steps — run these yourself</CardTitle>
        <CardDescription>
          These changes are staged in Garage&rsquo;s pending area. Nothing has
          moved and nothing will until you run the second command on a cluster
          host.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-12 font-mono text-xs">
            {commands.join('\n')}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-2 right-2"
            onClick={copy}
          >
            <Copy className="h-3.5 w-3.5" />
            <span className="sr-only">Copy commands</span>
          </Button>
        </div>
        <p className="text-sm">{APPLY_ONCE_WARNING}</p>
        <p className="text-muted-foreground text-sm">{NO_UNSTAGE_NOTICE}</p>
      </CardContent>
    </Card>
  );
}
