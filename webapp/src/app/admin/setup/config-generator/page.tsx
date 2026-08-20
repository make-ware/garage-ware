'use client';

import { useMemo, useReducer } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfigGeneratorForm } from '@/components/setup/config-generator-form';
import { ConfigGeneratorNextSteps } from '@/components/setup/config-generator-next-steps';
import { ConfigGeneratorPreview } from '@/components/setup/config-generator-preview';
import {
  configErrors,
  configReducer,
  DEFAULT_CONFIG_INPUT,
  generateGarageToml,
} from '@/lib/garage-config/garage-toml';
import {
  INVALID_HEADING,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
} from '@/lib/garage-config/garage-toml-copy';

/**
 * The GarageHQ config generator: a `garage.toml` for a cluster that does not
 * exist yet, built entirely in the browser.
 *
 * **It adds no endpoint, persists nothing, and never handles a secret.** Both
 * halves matter. There is no backend because there is nothing to ask a server:
 * the output is a pure function of the form, so the preview is a `useMemo` —
 * no fetch, no debounce, no request per keystroke, and nothing typed here
 * reaches PocketBase or a log. And the credentials are emitted as
 * `@PLACEHOLDER@` tokens with the command that produces each one beside them,
 * because a form field that accepts an RPC secret has invented a way to get one
 * into a browser history, a screenshot and a support ticket in exchange for
 * saving one `openssl` invocation. `garage-toml-secrets.test.ts` enforces that
 * structurally.
 *
 * This is the missing rung in the new-admin arc: `/admin/status` detects "no
 * cluster", links out to GarageHQ's docs, and then the operator has to
 * hand-write a config. It is admin-only for the same reason
 * `GARAGE_ADMIN_DOC_LINKS` is — it names this deployment's env vars and talks
 * about hosts a regular user has no business reading about.
 *
 * Errors do not blank the preview. An operator mid-way through fixing a port
 * should not watch the file they are building disappear, so `configErrors()`
 * renders above a preview that stays live — the planner's convention.
 */
export default function ConfigGeneratorPage() {
  const [input, dispatch] = useReducer(configReducer, DEFAULT_CONFIG_INPUT);

  const toml = useMemo(() => generateGarageToml(input), [input]);
  const errors = useMemo(() => configErrors(input), [input]);
  const dirty = useMemo(
    () =>
      (Object.keys(DEFAULT_CONFIG_INPUT) as (keyof typeof input)[]).some(
        (key) => input[key] !== DEFAULT_CONFIG_INPUT[key]
      ),
    [input]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{PAGE_TITLE}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {PAGE_DESCRIPTION}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => dispatch({ type: 'reset' })}
          disabled={!dirty}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset
        </Button>
      </div>

      {errors.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>{INVALID_HEADING}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <ConfigGeneratorForm input={input} dispatch={dispatch} />
      <ConfigGeneratorPreview toml={toml} />
      <ConfigGeneratorNextSteps />
    </div>
  );
}
