'use client';

/**
 * The Setup section: tools for a deployment that is not finished being set up.
 *
 * A section layout for the padding and the `<h1>`, matching
 * `admin/cluster/layout.tsx` and `admin/repairs/layout.tsx` — but with no tab
 * strip and no `page.tsx`. With one child a one-tab strip is noise, and a
 * `/admin/setup` index that only ever redirects is a route that 404s the first
 * time someone deletes the child. The sidebar entry points straight at
 * `/admin/setup/config-generator` instead; `admin/layout.tsx`'s
 * `pathname.startsWith(href)` lights it with no change to the matcher.
 *
 * No `<AdminRoute>` here: app/admin/layout.tsx already wraps this tree, and a
 * second wrapper double-runs the check.
 */
export default function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-5xl p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Setup</h1>
      </div>
      {children}
    </div>
  );
}
