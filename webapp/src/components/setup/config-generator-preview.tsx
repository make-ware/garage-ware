'use client';

import { ClipboardCopy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { downloadText } from '@/lib/download-text';
import {
  CONFIG_FILE_NAME,
  COPY_FAILURE,
  COPY_SUCCESS,
  DOWNLOAD_FAILURE,
  NO_SECRETS_NOTICE,
} from '@/lib/garage-config/garage-toml-copy';

/**
 * The generated file, exactly as it will be downloaded.
 *
 * The `<pre>` renders the same string `downloadText` writes — not a
 * re-rendering of the config — so what an operator reads and what they save
 * cannot disagree. Copy and download are both plain client-side operations;
 * there is no endpoint behind either.
 *
 * The no-secrets notice sits here rather than only at the top of the page
 * because this is where an operator looks when wondering what `@RPC_SECRET@`
 * is and whether the page was supposed to fill it in.
 */
export function ConfigGeneratorPreview({ toml }: { toml: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toml);
      toast.success(COPY_SUCCESS);
    } catch {
      toast.error(COPY_FAILURE);
    }
  };

  const download = () => {
    try {
      downloadText(CONFIG_FILE_NAME, toml, 'application/toml;charset=utf-8');
    } catch {
      toast.error(DOWNLOAD_FAILURE);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="font-mono">{CONFIG_FILE_NAME}</CardTitle>
            <CardDescription>{NO_SECRETS_NOTICE}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={copy}>
              <ClipboardCopy className="mr-2 h-4 w-4" />
              Copy
            </Button>
            <Button size="sm" onClick={download}>
              <Download className="mr-2 h-4 w-4" />
              Download {CONFIG_FILE_NAME}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-4 font-mono text-xs whitespace-pre">
          {toml}
        </pre>
      </CardContent>
    </Card>
  );
}
