'use client';

import * as React from 'react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { gbToGib, gibToGb, gibToTb, tbToGib } from '@/lib/storage/units';

export type StorageUnit = 'GB' | 'TB';

type Props = {
  /** Stored value in binary GiB (matches PocketBase). */
  valueGib: number;
  /** Emits the new value in binary GiB. */
  onChangeGib: (gib: number) => void;
  /** Display unit. Defaults to 'TB'. */
  unit?: StorageUnit;
  /** Optional max in GiB; used to derive the input's `max` attribute in display units. */
  maxGib?: number;
  /**
   * Optional min in GiB; used to derive the input's `min` attribute in display
   * units. Takes precedence over `min`. Pass a negative value to permit signed
   * amounts (the storage-claim ledger uses this for reclaim entries).
   */
  minGib?: number;
  /** Optional min in display units. Defaults to 0. Ignored when `minGib` is set. */
  min?: number;
  /** Decimals shown when seeding / re-syncing the input string. Defaults to 4. */
  decimals?: number;
  step?: number | 'any';
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};

function gibToDisplay(gib: number, unit: StorageUnit): number {
  return unit === 'TB' ? gibToTb(gib) : gibToGb(gib);
}

function displayToGib(value: number, unit: StorageUnit): number {
  return unit === 'TB' ? tbToGib(value) : gbToGib(value);
}

function formatSeed(gib: number, unit: StorageUnit, decimals: number): string {
  if (!Number.isFinite(gib) || gib === 0) return '0';
  const fixed = gibToDisplay(gib, unit).toFixed(decimals);
  return stripTrailingZeros(fixed);
}

function stripTrailingZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Numeric input for a storage quota expressed in decimal GB/TB.
 * Holds local string state so partial typing ("1.", "0.0") doesn't jitter,
 * and re-syncs from `valueGib` only when the field is not focused.
 */
export function StorageQuotaInput({
  valueGib,
  onChangeGib,
  unit = 'TB',
  maxGib,
  minGib,
  min = 0,
  decimals = 4,
  step = 'any',
  id,
  name,
  required,
  disabled,
  placeholder,
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: Props) {
  const [text, setText] = React.useState(() =>
    formatSeed(valueGib, unit, decimals)
  );
  const [focused, setFocused] = React.useState(false);
  const lastSeed = React.useRef<{ gib: number; unit: StorageUnit }>({
    gib: valueGib,
    unit,
  });

  React.useEffect(() => {
    if (focused) return;
    if (lastSeed.current.gib === valueGib && lastSeed.current.unit === unit) {
      return;
    }
    lastSeed.current = { gib: valueGib, unit };
    setText(formatSeed(valueGib, unit, decimals));
  }, [valueGib, unit, decimals, focused]);

  const maxDisplay =
    typeof maxGib === 'number' ? gibToDisplay(maxGib, unit) : undefined;
  const minDisplay =
    typeof minGib === 'number' ? gibToDisplay(minGib, unit) : min;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setText(next);
    if (next === '' || next === '-' || next === '.') {
      onChangeGib(0);
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) return;
    onChangeGib(displayToGib(parsed, unit));
  }

  return (
    <InputGroup className={className}>
      <InputGroupInput
        type="number"
        inputMode="decimal"
        id={id}
        name={name}
        value={text}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          lastSeed.current = { gib: valueGib, unit };
          setText(formatSeed(valueGib, unit, decimals));
        }}
        min={minDisplay}
        max={maxDisplay}
        step={step}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
      />
      <InputGroupAddon align="inline-end" data-slot="storage-quota-unit">
        {unit}
      </InputGroupAddon>
    </InputGroup>
  );
}
