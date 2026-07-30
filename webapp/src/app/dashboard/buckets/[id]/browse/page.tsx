'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  Upload,
} from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { api } from '@/lib/api-client';
import {
  S3BrowserError,
  downloadObject,
  listObjects,
  s3FromCredentials,
  uploadObject,
  type S3Credentials as Credentials,
  type S3Listing as ListResponse,
} from '@/lib/s3/browser';
import { useS3Config, type S3Config } from '@/lib/s3/config';
import { formatBytes } from '@/lib/format';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AccessKey, Bucket } from '@garage-ware/shared';
import type { GarageBucket } from '@/lib/garage';

interface DetailResponse {
  record: Bucket;
  garage: GarageBucket;
}

function credsStorageKey(bucketId: string) {
  return `s3creds:${bucketId}`;
}

function loadStoredCreds(bucketId: string): Credentials | null {
  try {
    const raw = sessionStorage.getItem(credsStorageKey(bucketId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Credentials;
    if (parsed?.accessKeyId && parsed?.secretAccessKey) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** The last path segment of a key/prefix, ignoring a trailing slash. */
function basename(keyOrPrefix: string): string {
  const trimmed = keyOrPrefix.replace(/\/$/, '');
  return trimmed.split('/').pop() || trimmed;
}

function CredentialGate({
  bucketName,
  onSubmit,
}: {
  bucketName: string;
  onSubmit: (creds: Credentials) => void;
}) {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await api<{ items: AccessKey[] }>('/next-api/garage/keys');
        if (cancelled) return;
        setKeys(resp.items);
        if (resp.items.length > 0) {
          setAccessKeyId(resp.items[0].garage_key_id);
        }
      } catch (err) {
        if (!cancelled)
          toast.error(
            err instanceof Error ? err.message : 'Failed to load keys'
          );
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function submit() {
    const id = accessKeyId.trim();
    const secret = secretAccessKey.trim();
    if (!id || !secret) {
      toast.error('Enter both an access key and secret');
      return;
    }
    onSubmit({ accessKeyId: id, secretAccessKey: secret });
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Enter S3 credentials</CardTitle>
        <CardDescription>
          Browsing <span className="font-medium">{bucketName}</span> talks to
          the S3 API directly from your browser. Provide an access key that has
          permission on this bucket.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Access key</Label>
          {keys.length > 0 ? (
            <Select value={accessKeyId} onValueChange={setAccessKeyId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a key" />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.garage_key_id}>
                    {k.name || '(unnamed)'} — {k.garage_key_id.slice(0, 12)}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              placeholder="GK..."
              autoComplete="off"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="secret">Secret key</Label>
          <Input
            id="secret"
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="Your secret access key"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>
        <Alert>
          <AlertDescription className="text-xs">
            Secret keys are shown only once at creation and never stored by this
            app. What you enter stays in this browser tab and is sent only to
            the storage cluster to sign your requests — it never reaches our
            server.
          </AlertDescription>
        </Alert>
        <Button onClick={submit} className="w-full">
          Browse files
        </Button>
      </CardContent>
    </Card>
  );
}

function FileBrowser({
  bucketName,
  creds,
  config,
  onCredsRejected,
}: {
  bucketName: string;
  creds: Credentials;
  config: S3Config;
  onCredsRejected: () => void;
}) {
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Active upload, or null when idle. `percent` is 0–100.
  const [upload, setUpload] = useState<{
    name: string;
    percent: number;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Key of the object whose download is currently in flight, or null.
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploading = upload !== null;

  // One S3 client per credential set; reused across navigation/uploads.
  const s3 = useMemo(() => s3FromCredentials(creds, config), [creds, config]);

  // Rejected credentials clear the stored secret and show the gate again.
  // Used by the event handlers; the effect inlines the same check so its
  // dependency list stays concrete.
  function handleError(err: unknown, fallback: string) {
    if (err instanceof S3BrowserError && err.isAuthError) {
      toast.error(err.message);
      onCredsRejected();
      return;
    }
    toast.error(err instanceof Error ? err.message : fallback);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await listObjects(s3, bucketName, prefix);
        if (cancelled) return;
        setListing(resp);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof S3BrowserError && err.isAuthError) {
          toast.error(err.message);
          onCredsRejected();
          return;
        }
        toast.error(
          err instanceof Error ? err.message : 'Failed to list files'
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [s3, bucketName, prefix, reloadKey, onCredsRejected]);

  // setState only ever happens in event handlers (not in the effect body) to
  // satisfy the strict react-hooks/set-state-in-effect rule. `navigate` and
  // `reload` flip `loading` before the effect re-runs from a dependency change.
  function navigate(nextPrefix: string) {
    setLoading(true);
    setPrefix(nextPrefix);
  }

  function reload() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  async function handleUpload(file: File) {
    setUpload({ name: file.name, percent: 0 });
    try {
      await uploadObject(s3, bucketName, prefix + file.name, file, (percent) =>
        setUpload({ name: file.name, percent })
      );
      toast.success(`Uploaded ${file.name}`);
      reload();
    } catch (err) {
      handleError(err, 'Upload failed');
    } finally {
      setUpload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDownload(key: string) {
    setDownloadingKey(key);
    try {
      const blob = await downloadObject(s3, bucketName, key);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = basename(key);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      handleError(err, 'Download failed');
    } finally {
      setDownloadingKey(null);
    }
  }

  // Breadcrumb segments built from the current prefix.
  const segments = prefix.split('/').filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => navigate('')}
            className="font-medium hover:underline"
          >
            {bucketName}
          </button>
          {segments.map((seg, i) => {
            const target = segments.slice(0, i + 1).join('/') + '/';
            return (
              <span key={target} className="flex items-center gap-1">
                <span className="text-muted-foreground">/</span>
                <button
                  type="button"
                  onClick={() => navigate(target)}
                  className="hover:underline"
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          {upload && (
            <div className="flex w-48 items-center gap-2">
              <Progress value={upload.percent} className="flex-1" />
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                {upload.percent}%
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <Button
            size="sm"
            className="gap-1.5"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {upload ? 'Uploading…' : 'Upload file'}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : !listing ||
            (listing.folders.length === 0 && listing.objects.length === 0) ? (
            <p className="p-6 text-sm text-muted-foreground">
              This {prefix ? 'folder' : 'bucket'} is empty. Upload a file to get
              started.
            </p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-24 text-right">Size</TableHead>
                  <TableHead className="hidden w-44 sm:table-cell">
                    Modified
                  </TableHead>
                  <TableHead className="w-36 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listing.folders.map((folder) => (
                  <TableRow
                    key={folder}
                    className="cursor-pointer"
                    onClick={() => navigate(folder)}
                  >
                    <TableCell className="font-medium">
                      <span
                        className="flex min-w-0 items-center gap-2"
                        title={`${basename(folder)}/`}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{basename(folder)}/</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      —
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      —
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
                {listing.objects.map((obj) => (
                  <TableRow key={obj.key}>
                    <TableCell className="font-medium">
                      <span
                        className="flex min-w-0 items-center gap-2"
                        title={basename(obj.key)}
                      >
                        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{basename(obj.key)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatBytes(obj.size)}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {obj.lastModified
                        ? new Date(obj.lastModified).toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        disabled={downloadingKey === obj.key}
                        onClick={() => void handleDownload(obj.key)}
                      >
                        {downloadingKey === obj.key ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />{' '}
                            Downloading…
                          </>
                        ) : (
                          <>
                            <Download className="h-3 w-3" /> Download
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BucketBrowse({ id }: { id: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const { config, error: configError } = useS3Config();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await api<DetailResponse>(
          `/next-api/garage/buckets/${id}`
        );
        if (cancelled) return;
        setData(detail);
        setCreds(loadStoredCreds(id));
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

  function acceptCreds(next: Credentials) {
    try {
      sessionStorage.setItem(credsStorageKey(id), JSON.stringify(next));
    } catch {
      /* sessionStorage may be unavailable; fall back to in-memory only */
    }
    setCreds(next);
  }

  function rejectCreds() {
    try {
      sessionStorage.removeItem(credsStorageKey(id));
    } catch {
      /* ignore */
    }
    setCreds(null);
  }

  if (loading || !data) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p>Loading...</p>
      </div>
    );
  }

  const bucketName = data.record.name;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href={`/dashboard/buckets/${id}`}
          className="text-sm text-muted-foreground hover:underline inline-flex items-center"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to {bucketName}
        </Link>
        <h1 className="text-3xl font-bold mt-2">Browse {bucketName}</h1>
        <p className="text-sm text-muted-foreground">
          List, upload, and download objects in this bucket.
        </p>
      </div>

      {creds ? (
        configError ? (
          <Alert variant="destructive">
            <AlertDescription>{configError}</AlertDescription>
          </Alert>
        ) : config ? (
          <FileBrowser
            bucketName={bucketName}
            creds={creds}
            config={config}
            onCredsRejected={rejectCreds}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )
      ) : (
        <CredentialGate bucketName={bucketName} onSubmit={acceptCreds} />
      )}
    </div>
  );
}

export default function BucketBrowsePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ProtectedRoute>
      <BucketBrowse id={id} />
    </ProtectedRoute>
  );
}
