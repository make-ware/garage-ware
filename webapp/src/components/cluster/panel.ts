/**
 * The card treatment the cluster page uses for its secondary panels: dashed
 * border, muted fill, no shadow.
 *
 * Extracted so the panels provably match rather than matching by coincidence.
 * It was a literal in `cluster-event-timeline.tsx` until the cost card needed
 * the same look, and two copies of a style string are two copies that drift.
 */
export const CLUSTER_PANEL_CLASS =
  'rounded-lg border-dashed bg-muted/30 shadow-none';
