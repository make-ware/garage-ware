'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { CLUSTER_PANEL_CLASS } from '@/components/cluster/panel';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The `garage layout` commands this plan implies, and the end of what the
 * planner does.
 *
 * Collapsed by default: the plan is the answer, the commands are how to act on
 * it. Deliberately text to copy rather than a button — staging from the app
 * would make a read-only tool a mutation tool, and `garage layout revert` is
 * not an undo, it clears staging by incrementing the layout version.
 *
 * A hypothetical node has no id to assign, so its line carries a placeholder:
 * the full 64-character node id is a credential and never reaches this page.
 */
export function PlannerCommands({ commands }: { commands: readonly string[] }) {
  if (commands.length === 0) return null;
  return (
    <Card className={cn(CLUSTER_PANEL_CLASS)}>
      <CardContent>
        <Accordion type="single" collapsible>
          <AccordionItem value="commands" className="border-none">
            <AccordionTrigger className="py-0">
              Commands for this plan
            </AccordionTrigger>
            <AccordionContent className="pt-4">
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {commands.join('\n')}
              </pre>
              <p className="text-muted-foreground mt-2 text-xs">
                Run these on a cluster node. Read `garage layout show` before
                `garage layout apply` — that output, not this page, is what
                Garage will actually do.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
