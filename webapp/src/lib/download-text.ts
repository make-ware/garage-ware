/**
 * Save a string the browser already holds as a file.
 *
 * The `createObjectURL` → anchor → `revokeObjectURL` dance is four lines that
 * are wrong in three different ways if you skip one of them: no `revoke` leaks
 * the blob for the life of the document, no `appendChild` fails in some
 * browsers, and no `remove` leaves an invisible anchor behind. The object
 * browser at `dashboard/buckets/[id]/browse` inlines its own copy because it
 * downloads a `Blob` it fetched from S3 rather than text it composed; this
 * exists so text-composing callers do not each add a fourth.
 *
 * Client-only by construction — it touches `document` and `URL`. Not marked
 * `'use client'` because it is a module, not a component; the components that
 * call it carry the directive.
 */
export function downloadText(
  filename: string,
  contents: string,
  mimeType = 'text/plain;charset=utf-8'
): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
