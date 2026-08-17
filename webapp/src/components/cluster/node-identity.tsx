import { cn } from '@/lib/utils';
import { type NodeKey, nodeKey } from '@/lib/node-label';

interface NodeIdentityProps {
  /** The node's name, or null when no `name:` tag supplies one. */
  name: string | null;
  /**
   * The node's key. Normalised again on the way in, so a caller that still
   * holds a longer id renders the key rather than leaking it.
   */
  nodeId: NodeKey;
  className?: string;
  /** Suffix slot for row-specific markers, e.g. "(not in layout)". */
  children?: React.ReactNode;
}

/**
 * How a table identifies a node: the name on top, the node key beneath.
 *
 * An unnamed node renders the key **alone** — never the same string on two
 * lines. That is the case most likely to regress silently, so it has a test.
 *
 * The component owns its own typography. The cells this replaced set
 * `font-mono text-xs` on the whole `<TableCell>`, which would render a node's
 * name in mono alongside its id; strip that class at the call site.
 */
export function NodeIdentity({
  name,
  nodeId,
  className,
  children,
}: NodeIdentityProps) {
  const key = nodeKey(nodeId);
  return (
    <div className={cn('min-w-0', className)}>
      {name ? (
        <>
          <span className="block truncate">
            {name}
            {children}
          </span>
          <span className="block font-mono text-xs text-muted-foreground">
            {key}
          </span>
        </>
      ) : (
        <span className="block font-mono text-xs">
          {key}
          {children}
        </span>
      )}
    </div>
  );
}
