import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './unique-violation';

/**
 * Three claim routes translate this predicate straight into a 409 with copy
 * telling the user somebody already holds the thing. It therefore has to be
 * true only when that is what happened — a 400 on the same field for any other
 * reason is a different problem with a different fix.
 */
function pbError(data: Record<string, unknown>, status = 400) {
  return { status, response: { data } };
}

const NOT_UNIQUE = {
  code: 'validation_not_unique',
  message: 'Must be unique.',
};

describe('isUniqueViolation', () => {
  it('is true for a UNIQUE index rejection on the named field', () => {
    expect(
      isUniqueViolation(
        pbError({ garage_bucket_id: NOT_UNIQUE }),
        'garage_bucket_id'
      )
    ).toBe(true);
  });

  it('is false for a different validation failure on the same field', () => {
    // The case that made this predicate wrong: a name too long for the column
    // was reported to the user as "a different bucket is already registered
    // under that alias", sending them after a collision that does not exist.
    const tooLong = {
      code: 'validation_length_out_of_range',
      message: 'Value is too long.',
    };
    expect(isUniqueViolation(pbError({ name: tooLong }), 'name')).toBe(false);
  });

  it('is false when a different field collided', () => {
    // Buckets carries two unique indexes and they mean different things.
    expect(
      isUniqueViolation(pbError({ name: NOT_UNIQUE }), 'garage_bucket_id')
    ).toBe(false);
  });

  it('is false for a non-400, and for a shapeless error', () => {
    expect(
      isUniqueViolation(pbError({ node_id: NOT_UNIQUE }, 500), 'node_id')
    ).toBe(false);
    expect(isUniqueViolation(new Error('boom'), 'node_id')).toBe(false);
    expect(isUniqueViolation(null, 'node_id')).toBe(false);
    expect(isUniqueViolation({ status: 400 }, 'node_id')).toBe(false);
  });

  it('is false when the field entry carries no code at all', () => {
    // Fails in the safe direction: an unrecognised shape becomes a 500, not a
    // confident "already claimed".
    expect(
      isUniqueViolation(pbError({ node_id: { message: 'nope' } }), 'node_id')
    ).toBe(false);
  });
});
