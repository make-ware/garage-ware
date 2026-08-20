import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ClusterPlannerPage from './page';
import {
  APPROXIMATION_DISCLAIMER,
  EXAMPLE_ONE_ADVICE,
  NO_WRITE_NOTICE,
} from '@/lib/cluster/planner-copy';

const { mockApi, mockMetrics } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  mockMetrics: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/pocketbase', () => ({ default: {} }));
vi.mock('@/lib/metrics/latest-node-metrics', () => ({
  fetchLatestNodeMetrics: mockMetrics,
}));

/**
 * The documented Example 1 starting point: three 1000 MB nodes, one per zone.
 * `partitionSize` is Garage's own answer for that layout — 1000 MB / 256 — so
 * the conformance badge has something real to agree with.
 */
const MB = 1_000_000;
const LAYOUT = {
  version: 7,
  roles: [
    {
      id: 'aaaa000000000001',
      zone: 'dc1',
      capacity: 1000 * MB,
      tags: ['name:node1'],
    },
    {
      id: 'aaaa000000000002',
      zone: 'dc2',
      capacity: 1000 * MB,
      tags: ['name:node2'],
    },
    {
      id: 'aaaa000000000003',
      zone: 'dc3',
      capacity: 1000 * MB,
      tags: ['name:node3'],
    },
  ],
  parameters: { zoneRedundancy: 'maximum' as const },
  partitionSize: 3_906_250,
  stagedRoleChanges: [] as unknown[],
  replicationFactor: 3,
};

function metricsMap(overrides: Record<string, unknown> = {}) {
  return new Map(
    LAYOUT.roles.map((role) => [
      role.id,
      {
        layout_ok: true,
        role_ok: true,
        layout_version: 7,
        stored_partitions: 256,
        ...overrides,
      },
    ])
  );
}

function setup(layout: Partial<typeof LAYOUT> = {}, metrics = metricsMap()) {
  mockApi.mockImplementation(async () => ({ ...LAYOUT, ...layout }));
  mockMetrics.mockResolvedValue(metrics);
  return render(<ClusterPlannerPage />);
}

/** The zone/capacity inputs for a row, addressed the way a screen reader would. */
const zoneInput = (label: string) => screen.getByLabelText(`Zone for ${label}`);
const capacityInput = (label: string) =>
  screen.getByLabelText(`Capacity for ${label}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cluster layout planner', () => {
  it('states that it is an approximation before anything is fetched', async () => {
    // The disclaimer is the feature, not decoration around it: a planner whose
    // per-node numbers can differ from Garage's and does not say so gets
    // quoted back as fact.
    const { container } = setup();
    expect(container.textContent).toContain(APPROXIMATION_DISCLAIMER);
    expect(container.textContent).toContain(NO_WRITE_NOTICE);
    await screen.findByText('Planned nodes');
  });

  it('prefills the table from the live layout', async () => {
    setup();
    await screen.findByText('Planned nodes');
    expect((zoneInput('node1') as HTMLInputElement).value).toBe('dc1');
    expect((capacityInput('node1') as HTMLInputElement).value).toBe('1');
    // Three equal nodes in three zones: the whole ring each, 100% usable.
    expect(screen.getAllByText('100.0%').length).toBeGreaterThanOrEqual(3);
  });

  it('confirms the simulation matches this cluster’s own partition size', async () => {
    setup();
    expect(await screen.findByText('Matches this cluster')).toBeDefined();
  });

  it('says so instead when it disagrees with the cluster', async () => {
    setup({ partitionSize: 4_000_000 });
    expect(await screen.findByText('Differs from this cluster')).toBeDefined();
    expect(screen.queryByText('Matches this cluster')).toBeNull();
  });

  it('suppresses the comparison while staged changes are pending', async () => {
    // Garage's reported partitionSize describes the *applied* layout, so with
    // staged changes the comparison means nothing.
    setup({ stagedRoleChanges: [{ id: 'x' }] });
    expect(await screen.findByText('Staged changes pending')).toBeDefined();
    expect(screen.queryByText('Matches this cluster')).toBeNull();
  });

  it('recomputes when a capacity is edited', async () => {
    setup();
    await screen.findByText('Planned nodes');
    expect(screen.getByText('3.9 MB')).toBeDefined(); // partition size

    // Halving every node halves the partition size; nothing else changes.
    for (const name of ['node1', 'node2', 'node3']) {
      fireEvent.change(capacityInput(name), { target: { value: '0.5' } });
    }
    await waitFor(() => expect(screen.getByText('2 MB')).toBeDefined());
  });

  it('reproduces the documented zero-partition trap and gives the fix', async () => {
    setup();
    await screen.findByText('Planned nodes');

    fireEvent.click(screen.getByRole('button', { name: /Add node/ }));
    fireEvent.change(zoneInput('new-1'), { target: { value: 'dc1' } });
    fireEvent.change(capacityInput('new-1'), { target: { value: '1' } });

    // The new dc1 node is assigned nothing: dc2 and dc3 still bound the total,
    // so moving data into dc1 would buy no capacity.
    const warning = await screen.findByText(/would store nothing/);
    expect(warning).toBeDefined();
    expect(document.body.textContent).toContain(EXAMPLE_ONE_ADVICE);
  });

  it('drops the warning once the oversized zone declares half capacity', async () => {
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.click(screen.getByRole('button', { name: /Add node/ }));
    fireEvent.change(zoneInput('new-1'), { target: { value: 'dc1' } });
    fireEvent.change(capacityInput('new-1'), { target: { value: '1' } });
    await screen.findByText(/would store nothing/);

    // The documented fix: halve both dc1 nodes and they share the zone.
    fireEvent.change(capacityInput('node1'), { target: { value: '0.5' } });
    fireEvent.change(capacityInput('new-1'), { target: { value: '0.5' } });
    await waitFor(() =>
      expect(screen.queryByText(/would store nothing/)).toBeNull()
    );
  });

  it('turns a node into a gateway and takes its capacity out of the plan', async () => {
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.click(screen.getByLabelText('Gateway for node3'));
    // Two storage nodes cannot satisfy a replication factor of 3.
    expect(
      await screen.findByText('This plan has no valid layout')
    ).toBeDefined();
  });

  it('renders no numbers at all for a plan with no layout', async () => {
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.click(screen.getByLabelText('Remove node2'));
    fireEvent.click(screen.getByLabelText('Remove node3'));

    const alert = await screen.findByText('This plan has no valid layout');
    expect(alert).toBeDefined();
    // A partition size or a usable total beside "this cannot work" is exactly
    // what an operator would copy down.
    expect(document.body.textContent).not.toContain('Partition size');
    expect(document.body.textContent).not.toContain('Effective capacity');
    expect(screen.queryByText('Zones')).toBeNull();
  });

  it('removes and adds rows without disturbing the others', async () => {
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.click(screen.getByLabelText('Remove node3'));
    expect(screen.queryByLabelText('Zone for node3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Add node/ }));
    expect(screen.getByLabelText('Zone for new-1')).toBeDefined();
    expect((zoneInput('node1') as HTMLInputElement).value).toBe('dc1');
  });

  it('falls back to an estimated baseline when the samples are stale', async () => {
    // Samples are up to 15 minutes old; one from a previous layout version
    // describes a different assignment entirely.
    setup({}, metricsMap({ layout_version: 6 }));
    await screen.findByText('Planned nodes');
    expect(
      await screen.findByText(/older layout version than the one on screen/)
    ).toBeDefined();
  });

  it('says nothing about the baseline when Garage’s own counts are usable', async () => {
    setup();
    await screen.findByText('Planned nodes');
    expect(document.body.textContent).not.toContain('estimated</em> baseline');
    expect(screen.queryByText(/Movement is measured against an/)).toBeNull();
  });

  it('never asks the server to stage, apply or revert anything', async () => {
    // Structural, so nobody has to remember the rule: the planner reads one
    // display route and writes nothing. `garage layout revert` is not an undo
    // — it clears staging by incrementing the layout version.
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.click(screen.getByRole('button', { name: /Add node/ }));
    fireEvent.change(capacityInput('node1'), { target: { value: '99' } });

    const paths = mockApi.mock.calls.map((call) => String(call[0]));
    expect(paths).toEqual(['/next-api/garage/cluster/layout']);
    for (const path of paths) {
      expect(path).not.toMatch(/staged|apply|revert/);
    }
    expect(mockApi.mock.calls.every((call) => call[1] === undefined)).toBe(
      true
    );
  });

  it('offers the commands for the plan rather than running them', async () => {
    setup();
    await screen.findByText('Planned nodes');
    fireEvent.change(capacityInput('node1'), { target: { value: '2' } });
    expect(await screen.findByText('Commands for this plan')).toBeDefined();
  });
});
