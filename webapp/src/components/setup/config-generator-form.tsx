'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  REPLICATION_FACTORS,
  type ConfigAction,
  type GarageConfigInput,
  type ReplicationFactor,
} from '@/lib/garage-config/garage-toml';
import {
  LAYOUT_NOT_IN_TOML_NOTICE,
  REPLICATION_RECOMMENDATION,
  REPLICATION_TRADEOFFS,
} from '@/lib/garage-config/garage-toml-copy';

/**
 * The form half of the config generator.
 *
 * **There is no secret field here and there must never be one.** The RPC secret
 * and the admin token leave as placeholders the operator fills in on the host —
 * see the docblock on `lib/garage-config/garage-toml.ts`, and the structural
 * guard in `garage-toml-secrets.test.ts` that fails if this drifts.
 *
 * Every control is uncontrolled-by-value and dispatches straight into the
 * reducer, so the preview beside it is a `useMemo` over one object rather than
 * a state machine. No form library: there is nothing to submit.
 */
interface ConfigGeneratorFormProps {
  input: GarageConfigInput;
  dispatch: React.Dispatch<ConfigAction>;
}

/** `NaN` is what an empty number input parses to; show it as empty, not "NaN". */
function numberValue(value: number): string {
  return Number.isNaN(value) ? '' : String(value);
}

export function ConfigGeneratorForm({
  input,
  dispatch,
}: ConfigGeneratorFormProps) {
  const text =
    (field: Extract<ConfigAction, { type: 'set' }>['field']) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      dispatch({ type: 'set', field, value: event.target.value });

  const number =
    (field: Extract<ConfigAction, { type: 'setNumber' }>['field']) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      dispatch({
        type: 'setNumber',
        field,
        value: Number.parseInt(event.target.value, 10),
      });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Storage paths</CardTitle>
          <CardDescription>
            Where each node keeps its two halves. Metadata is latency-sensitive
            and wants an SSD; data is bulk storage.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="metadata-dir">Metadata directory</Label>
            <Input
              id="metadata-dir"
              value={input.metadataDir}
              onChange={text('metadataDir')}
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="data-dir">Data directory</Label>
            <Input
              id="data-dir"
              value={input.dataDir}
              onChange={text('dataDir')}
              spellCheck={false}
              className="font-mono"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Replication factor</CardTitle>
          <CardDescription>{REPLICATION_RECOMMENDATION}</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={String(input.replicationFactor)}
            onValueChange={(value) =>
              dispatch({
                type: 'setReplicationFactor',
                value: Number(value) as ReplicationFactor,
              })
            }
          >
            {REPLICATION_FACTORS.map((factor) => (
              <div key={factor} className="flex items-start gap-3">
                <RadioGroupItem
                  value={String(factor)}
                  id={`replication-${factor}`}
                  className="mt-1"
                />
                <div className="space-y-1">
                  <Label
                    htmlFor={`replication-${factor}`}
                    className="font-medium"
                  >
                    {factor}
                    {factor === 3 ? ' (recommended)' : ''}
                  </Label>
                  <p className="text-muted-foreground text-sm">
                    {REPLICATION_TRADEOFFS[factor]}
                  </p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Listeners</CardTitle>
          <CardDescription>
            The bind address applies to all three listeners.{' '}
            <code className="font-mono">[::]</code> means every interface. To
            put one of them on a private interface only, edit that line in the
            generated file.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bind-host">Bind address</Label>
            <Input
              id="bind-host"
              value={input.bindHost}
              onChange={text('bindHost')}
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpc-port">RPC port</Label>
            <Input
              id="rpc-port"
              type="number"
              value={numberValue(input.rpcPort)}
              onChange={number('rpcPort')}
            />
            <p className="text-muted-foreground text-xs">
              How nodes talk to each other. Not a client-facing port.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="s3-api-port">S3 API port</Label>
            <Input
              id="s3-api-port"
              type="number"
              value={numberValue(input.s3ApiPort)}
              onChange={number('s3ApiPort')}
            />
            <p className="text-muted-foreground text-xs">
              What this deployment&apos;s{' '}
              <code className="font-mono">GARAGE_S3_ENDPOINT</code> points at.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-api-port">Admin API port</Label>
            <Input
              id="admin-api-port"
              type="number"
              value={numberValue(input.adminApiPort)}
              onChange={number('adminApiPort')}
            />
            <p className="text-muted-foreground text-xs">
              garage-ware talks to this port. It must be reachable from wherever
              garage-ware runs, and it is what{' '}
              <code className="font-mono">GARAGE_ADMIN_URL</code> points at.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>S3 API</CardTitle>
          <CardDescription>
            The region has to match this deployment&apos;s{' '}
            <code className="font-mono">GARAGE_S3_REGION</code> — a mismatch
            fails request signing, not connection, so it looks like a
            credentials problem.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="s3-region">Region</Label>
            <Input
              id="s3-region"
              value={input.s3Region}
              onChange={text('s3Region')}
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s3-root-domain">Root domain (optional)</Label>
            <Input
              id="s3-root-domain"
              value={input.s3RootDomain}
              onChange={text('s3RootDomain')}
              placeholder=".s3.example.com"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-muted-foreground text-xs">
              Enables vhost-style addressing (
              <code className="font-mono">bucket.s3.example.com</code>)
              alongside path-style. Leave blank and the key is omitted entirely.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Layout hints</CardTitle>
          <CardDescription>{LAYOUT_NOT_IN_TOML_NOTICE}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="node-count">Nodes</Label>
            <Input
              id="node-count"
              type="number"
              value={numberValue(input.nodeCount)}
              onChange={number('nodeCount')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="zone">Zone</Label>
            <Input
              id="zone"
              value={input.zone}
              onChange={text('zone')}
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="capacity">Capacity per node</Label>
            <Input
              id="capacity"
              value={input.capacity}
              onChange={text('capacity')}
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-muted-foreground text-xs">
              Decimal, as the CLI takes it:{' '}
              <code className="font-mono">1T</code>,{' '}
              <code className="font-mono">1.5T</code>,{' '}
              <code className="font-mono">500G</code>.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
