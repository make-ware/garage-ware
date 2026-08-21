import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RecoveryGuidePage from './page';
import { RECOVERY_GUIDE, guideOutcome } from '@/lib/repair/recovery-guide';

/**
 * All four paths, walked. The page fetches nothing and persists nothing, so
 * there is no mocking here at all — which is itself the property being pinned:
 * every sentence it can render is a string in `recovery-guide.ts`.
 */

const root = RECOVERY_GUIDE.questions.find(
  (q) => q.id === RECOVERY_GUIDE.rootId
)!;

/** Click an option by its label text. */
function choose(label: string) {
  fireEvent.click(screen.getByText(label).closest('button') as HTMLElement);
}

function outcomeTitle(id: string) {
  return guideOutcome(id)!.title;
}

describe('RecoveryGuidePage', () => {
  it('opens on the root question and offers every branch', () => {
    render(<RecoveryGuidePage />);
    expect(screen.getByText(root.prompt)).toBeInTheDocument();
    for (const option of root.options) {
      expect(screen.getByText(option.label)).toBeInTheDocument();
    }
  });

  it('reaches the block-repair leaf from a failed disk', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[0].label);

    expect(
      screen.getByText(outcomeTitle('drive-replaced'))
    ).toBeInTheDocument();
    const link = screen.getByText('Blocks repair').closest('a');
    expect(link).toHaveAttribute('href', '/admin/repairs/blocks');
  });

  it('reaches the staging leaf from a lost node, with the apply command', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[1].label);

    expect(
      screen.getByText(outcomeTitle('node-lost-new-id'))
    ).toBeInTheDocument();
    expect(screen.getByText('Layout staging').closest('a')).toHaveAttribute(
      'href',
      '/admin/cluster/staging'
    );
    // Naming the version is what makes a second, accidental apply fail.
    expect(
      screen.getByText(/garage layout apply --version/)
    ).toBeInTheDocument();
  });

  it('asks a second question before sending anyone to a metadata repair', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[2].label);

    // A root with four options is a menu; this is the question that separates
    // "replace the drive" from "the metadata DB is corrupt".
    const second = RECOVERY_GUIDE.questions.find((q) => q.id === 'q-meta')!;
    expect(screen.getByText(second.prompt)).toBeInTheDocument();
    expect(screen.queryByText(outcomeTitle('meta-corrupted'))).toBeNull();

    choose(second.options[1].label);
    expect(
      screen.getByText(outcomeTitle('meta-corrupted'))
    ).toBeInTheDocument();
    // The leaf that says the app stops here.
    expect(screen.getByText('garage CLI only')).toBeInTheDocument();
  });

  it('reaches the quorum leaf and refuses to send anyone to a repair', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[3].label);

    expect(screen.getByText(outcomeTitle('quorum-lost'))).toBeInTheDocument();
    expect(screen.getByText('Status').closest('a')).toHaveAttribute(
      'href',
      '/admin/status'
    );
    expect(screen.getByText('garage CLI only')).toBeInTheDocument();
  });

  it('discards the answers below a question that is answered again', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[2].label);
    choose(
      RECOVERY_GUIDE.questions.find((q) => q.id === 'q-meta')!.options[1].label
    );
    expect(
      screen.getByText(outcomeTitle('meta-corrupted'))
    ).toBeInTheDocument();

    choose(root.options[3].label);
    // The old branch's answer belongs to a path no longer taken.
    expect(screen.queryByText(outcomeTitle('meta-corrupted'))).toBeNull();
    expect(screen.getByText(outcomeTitle('quorum-lost'))).toBeInTheDocument();
  });

  it('returns to the root on Start over', () => {
    render(<RecoveryGuidePage />);
    choose(root.options[0].label);
    expect(
      screen.getByText(outcomeTitle('drive-replaced'))
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Start over/ }));
    expect(screen.queryByText(outcomeTitle('drive-replaced'))).toBeNull();
    expect(screen.getByText(root.prompt)).toBeInTheDocument();
  });
});
