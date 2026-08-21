'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, ExternalLink, RotateCcw } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  GARAGE_RECOVERING_DOC,
  GUIDE_HEDGE,
  RECOVERY_GUIDE,
  guideOutcome,
  guideQuestion,
  type GuideOption,
} from '@/lib/repair/recovery-guide';

/**
 * Garage's recovery procedure, walked one question at a time.
 *
 * **Client-only, no endpoint, nothing persisted** — the
 * `/admin/cluster/planner` and `/admin/setup/config-generator` pattern. There
 * is no free text and no model call: every sentence this page can render is a
 * string in `lib/repair/recovery-guide.ts`, so it cannot invent a procedure.
 *
 * **Deliberately no URL state.** A deep link to a leaf would hand somebody "run
 * a block repair" without the question that produced it, and the questions are
 * the feature. The cost is real — an incident channel gets a link to the guide
 * rather than to an answer — and it is the trade this page chooses.
 */
export default function RecoveryGuidePage() {
  /** Ids of the options taken, in order. The path *is* the state. */
  const [path, setPath] = useState<GuideOption[]>([]);

  // Walk from the root, following the answers. Each step is either the next
  // question or the outcome the last answer named.
  const steps: {
    question: ReturnType<typeof guideQuestion>;
    chosen: GuideOption | null;
  }[] = [];
  let currentId: string | null = RECOVERY_GUIDE.rootId;
  let index = 0;
  while (currentId) {
    const question = guideQuestion(currentId);
    if (!question) break;
    const chosen = path[index] ?? null;
    steps.push({ question, chosen });
    if (!chosen) {
      currentId = null;
    } else {
      currentId = chosen.next;
      index += 1;
    }
  }
  const outcome = currentId ? guideOutcome(currentId) : null;

  const choose = (stepIndex: number, option: GuideOption) => {
    // Answering an earlier question discards the answers below it, which is the
    // only correct thing to do — they belong to a branch no longer taken.
    setPath((prev) => [...prev.slice(0, stepIndex), option]);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Recovering from a failure</CardTitle>
          <CardDescription>
            A guided route through Garage&rsquo;s own{' '}
            <a
              href={GARAGE_RECOVERING_DOC}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              recovering-from-failures guide
            </a>
            , mapped onto what this app can and cannot do. Answer what you know;
            each answer narrows to one procedure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{GUIDE_HEDGE}</p>
        </CardContent>
      </Card>

      {steps.map(({ question, chosen }, stepIndex) =>
        question ? (
          <Card key={question.id}>
            <CardHeader>
              <CardTitle className="text-base">{question.prompt}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {question.options.map((option) => (
                <Button
                  key={option.id}
                  variant={chosen?.id === option.id ? 'secondary' : 'outline'}
                  className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                  onClick={() => choose(stepIndex, option)}
                >
                  <span>
                    <span className="block">{option.label}</span>
                    {option.hint && (
                      <span className="text-muted-foreground block text-xs font-normal">
                        {option.hint}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </CardContent>
          </Card>
        ) : null
      )}

      {outcome && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {outcome.title}
              {/* Said out loud on every leaf: whether this app does the thing,
                  or only points at it. An unstated boundary is one that erodes. */}
              <Badge variant={outcome.handledByApp ? 'secondary' : 'outline'}>
                {outcome.handledByApp
                  ? 'garage-ware can help'
                  : 'garage CLI only'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {outcome.body.map((para, i) => (
              <p key={i} className="text-sm">
                {para}
              </p>
            ))}

            {outcome.commands && (
              <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
                {outcome.commands.join('\n')}
              </pre>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {outcome.links.map((link) =>
                link.kind === 'internal' ? (
                  <Link key={link.href} href={link.href}>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      {link.label} <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                ) : (
                  <a
                    key={link.href + link.label}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Button variant="ghost" size="sm" className="gap-1.5">
                      {link.label} <ExternalLink className="h-4 w-4" />
                    </Button>
                  </a>
                )
              )}
            </div>

            <p className="text-muted-foreground text-xs">{GUIDE_HEDGE}</p>
          </CardContent>
        </Card>
      )}

      {path.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setPath([])}
        >
          <RotateCcw className="h-4 w-4" />
          Start over
        </Button>
      )}
    </div>
  );
}
