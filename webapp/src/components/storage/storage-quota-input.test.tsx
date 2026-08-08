import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { StorageQuotaInput } from './storage-quota-input';
import { gbToGib, tbToGib } from '@/lib/storage/units';

function Harness({
  initialGib = 0,
  unit,
  onChange,
}: {
  initialGib?: number;
  unit?: 'GB' | 'TB';
  onChange?: (g: number) => void;
}) {
  const [v, setV] = useState(initialGib);
  return (
    <StorageQuotaInput
      valueGib={v}
      onChangeGib={(g) => {
        setV(g);
        onChange?.(g);
      }}
      unit={unit}
    />
  );
}

describe('StorageQuotaInput', () => {
  it('renders the TB suffix by default', () => {
    render(<Harness />);
    expect(screen.getByText('TB')).toBeInTheDocument();
  });

  it('renders the GB suffix when unit="GB"', () => {
    render(<Harness unit="GB" />);
    expect(screen.getByText('GB')).toBeInTheDocument();
  });

  it('seeds the input from valueGib in TB', () => {
    render(<Harness initialGib={tbToGib(2.5)} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    // Allow trailing-zero stripping; numeric value is 2.5
    expect(Number(input.value)).toBeCloseTo(2.5, 4);
  });

  it('seeds the input from valueGib in GB when unit="GB"', () => {
    render(<Harness unit="GB" initialGib={gbToGib(500)} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(Number(input.value)).toBeCloseTo(500, 4);
  });

  it('emits the value in GiB when typing TB', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last).toBeCloseTo(tbToGib(1), 6);
  });

  it('emits the value in GiB when typing GB (unit="GB")', () => {
    const onChange = vi.fn();
    render(<Harness unit="GB" onChange={onChange} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '500' } });
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last).toBeCloseTo(gbToGib(500), 6);
  });

  it('treats an empty value as 0', () => {
    const onChange = vi.fn();
    render(<Harness initialGib={tbToGib(1)} onChange={onChange} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('preserves the user’s in-progress text while focused even when valueGib changes', () => {
    function FocusHarness() {
      const [v, setV] = useState(tbToGib(1));
      return (
        <>
          <button onClick={() => setV(tbToGib(5))}>bump</button>
          <StorageQuotaInput valueGib={v} onChangeGib={setV} />
        </>
      );
    }
    render(<FocusHarness />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '2.' } });
    fireEvent.click(screen.getByText('bump'));
    expect(input.value).toBe('2.');
  });

  it('seeds within its own max, so the form can actually be submitted', () => {
    // Regression: a node with 18.66666… TB free seeded the text "18.6667",
    // which is above the max attribute. The field then reports itself invalid
    // and the browser refuses to submit the enclosing form — silently, from
    // the admin's point of view.
    const freeGib = tbToGib(18.6666666666);
    render(
      <StorageQuotaInput
        valueGib={freeGib}
        onChangeGib={vi.fn()}
        maxGib={freeGib}
      />
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('18.6666');
    expect(Number(input.value)).toBeLessThanOrEqual(Number(input.max));
    expect(input.validity.rangeOverflow).toBe(false);
  });

  it('floors the min bound outward so a full reclaim stays typeable', () => {
    render(
      <StorageQuotaInput
        valueGib={0}
        onChangeGib={vi.fn()}
        minGib={-tbToGib(3.00005)}
      />
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(Number(input.min)).toBeLessThanOrEqual(-3.00005);
  });

  it('re-syncs the displayed text from valueGib when not focused', () => {
    function ExternalHarness() {
      const [v, setV] = useState(tbToGib(1));
      return (
        <>
          <button onClick={() => setV(tbToGib(3))}>bump</button>
          <StorageQuotaInput valueGib={v} onChangeGib={setV} />
        </>
      );
    }
    render(<ExternalHarness />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.click(screen.getByText('bump'));
    expect(Number(input.value)).toBeCloseTo(3, 4);
  });
});
