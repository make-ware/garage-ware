'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Info } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { api } from '@/lib/api-client';
import { useS3Config } from '@/lib/s3/config';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { AccessKey, Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage';

interface DetailResponse {
  record: Bucket;
  garage: GarageBucket;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={copy}
      className="h-7 gap-1 text-xs"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative rounded-md bg-muted">
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 pr-20 text-sm font-mono whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function BucketConnect({ id }: { id: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const { config, error: configError } = useS3Config();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [detail, keysResp] = await Promise.all([
          api<DetailResponse>(`/next-api/garage/buckets/${id}`),
          api<{ items: AccessKey[] }>('/next-api/garage/keys'),
        ]);
        if (cancelled) return;
        setData(detail);
        setKeys(keysResp.items);
        if (keysResp.items.length > 0) {
          setSelectedKeyId(keysResp.items[0].garage_key_id);
        }
      } catch (err) {
        if (!cancelled)
          toast.error(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (configError) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert variant="destructive">
          <AlertDescription>{configError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading || !data || !config) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p>Loading...</p>
      </div>
    );
  }

  const endpoint = config.publicEndpoint;
  const REGION = config.region;
  const bucketName = data.record.name;
  const keyId = selectedKeyId || '<YOUR_ACCESS_KEY_ID>';
  const secretPlaceholder = '<YOUR_SECRET_KEY>';

  const awsCredentials = `[default]
aws_access_key_id=${keyId}
aws_secret_access_key=${secretPlaceholder}`;

  const awsConfig = `[default]
region=${REGION}
endpoint_url=${endpoint}`;

  const awsCommands = `# list all your buckets
aws s3 ls

# list objects in this bucket
aws s3 ls s3://${bucketName}/

# upload a file
aws s3 cp /path/to/file.txt s3://${bucketName}/file.txt

# download a file
aws s3 cp s3://${bucketName}/file.txt /path/to/file.txt

# sync a local directory to the bucket
aws s3 sync ./local-dir s3://${bucketName}/`;

  const awsBashrcWorkaround = `function aws { command aws --endpoint-url ${endpoint} "$@" ; }`;

  const rcloneConfig = `[garage]
type = s3
provider = Other
env_auth = false
access_key_id = ${keyId}
secret_access_key = ${secretPlaceholder}
region = ${REGION}
endpoint = ${endpoint}
force_path_style = true
acl = private
bucket_acl = private`;

  const rcloneCommands = `# list all buckets
rclone lsd garage:

# list objects in this bucket
rclone lsd garage:${bucketName}

# copy a file to the bucket
rclone copy /path/to/file.txt garage:${bucketName}/

# copy a file from the bucket
rclone copy garage:${bucketName}/file.txt /path/to/

# sync a local directory (add --fast-list for large buckets)
rclone sync ./local-dir garage:${bucketName} --fast-list`;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-6">
        <Link
          href={`/dashboard/buckets/${id}`}
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to {bucketName}
        </Link>
        <h1 className="text-3xl font-bold mt-2">Connect to {bucketName}</h1>
        <p className="text-sm text-muted-foreground">
          Configuration templates for S3-compatible clients.
        </p>
      </div>

      <div className="flex flex-wrap gap-4 mb-6">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Endpoint</p>
          <code className="inline-flex h-9 w-fit max-w-full items-center overflow-x-auto rounded-md border bg-muted px-3 font-mono text-sm whitespace-nowrap">
            {endpoint}
          </code>
        </div>

        {keys.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Access key</p>
            <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.garage_key_id}>
                    {k.name || '(unnamed)'} — {k.garage_key_id.slice(0, 12)}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <Alert className="mb-6">
        <Info className="h-4 w-4" />
        <AlertDescription>
          Replace <code className="font-mono text-xs">{secretPlaceholder}</code>{' '}
          with your actual secret key. Secret keys are shown once at creation
          and never stored — check your records or{' '}
          <Link
            href="/dashboard/keys"
            className="underline hover:text-foreground"
          >
            rotate the key
          </Link>{' '}
          if needed.
        </AlertDescription>
      </Alert>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>AWS CLI</CardTitle>
          <CardDescription>
            Requires awscli ≥ 1.29.0 or ≥ 2.13.0 for{' '}
            <code className="font-mono text-xs">endpoint_url</code> in config.
            Older versions need the workaround below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">
              <code className="font-mono">~/.aws/credentials</code>
            </p>
            <CodeBlock code={awsCredentials} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">
              <code className="font-mono">~/.aws/config</code>
            </p>
            <CodeBlock code={awsConfig} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Common commands</p>
            <CodeBlock code={awsCommands} />
          </div>
          <Alert>
            <AlertDescription className="text-xs">
              <span className="font-medium">Older awscli workaround:</span> add
              this to <code className="font-mono">~/.bashrc</code> then run{' '}
              <code className="font-mono">source ~/.bashrc</code>:
              <div className="mt-2">
                <CodeBlock code={awsBashrcWorkaround} />
              </div>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>rclone</CardTitle>
          <CardDescription>
            Add the block below to{' '}
            <code className="font-mono text-xs">
              ~/.config/rclone/rclone.conf
            </code>{' '}
            or run <code className="font-mono text-xs">rclone config</code> to
            configure interactively.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">rclone.conf</p>
            <CodeBlock code={rcloneConfig} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Common commands</p>
            <CodeBlock code={rcloneCommands} />
          </div>
          <Alert>
            <AlertDescription className="text-xs space-y-1">
              <p>
                <span className="font-medium">Large buckets:</span> use{' '}
                <code className="font-mono">--fast-list</code> to batch{' '}
                <code className="font-mono">ListObjects</code> calls and speed
                up operations like{' '}
                <code className="font-mono">rclone sync</code> or{' '}
                <code className="font-mono">rclone ncdu</code>.
              </p>
              <p>
                <span className="font-medium">Proxy / Cloudflare:</span> if you
                see <code className="font-mono">403 Invalid signature</code>,
                add{' '}
                <code className="font-mono">
                  --s3-sign-accept-encoding=false
                </code>{' '}
                to your command.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compatibility notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Region:</span> This
            cluster uses region{' '}
            <code className="font-mono text-xs">{REGION}</code>. Clients that
            default to a different region will receive signature errors.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Signature version:
            </span>{' '}
            Garage requires AWS Signature V4. Clients that default to the older
            V2 signature scheme will fail — configure them to use V4 explicitly.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Path-style access:
            </span>{' '}
            Garage uses path-style bucket addressing (
            <code className="font-mono text-xs">
              {endpoint}/{bucketName}
            </code>
            ). Virtual-hosted style (
            <code className="font-mono text-xs">
              {bucketName}.s3.example.com
            </code>
            ) requires matching DNS records.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Unsupported features:
            </span>{' '}
            Garage is S3-compatible but does not implement every AWS S3 feature
            (e.g. object versioning, object lock, bucket ACLs, website hosting).
            See the{' '}
            <a
              href="https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Garage S3 compatibility reference
            </a>{' '}
            for the full list.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BucketConnectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ProtectedRoute>
      <BucketConnect id={id} />
    </ProtectedRoute>
  );
}
