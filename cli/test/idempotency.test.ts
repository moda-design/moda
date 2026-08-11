import { describe, expect, test } from 'bun:test';
import { deriveIdempotencyKey } from '../src/api/idempotency.ts';

describe('idempotency-key derivation (cli.md §4.1)', () => {
  const base = {
    command: 'canvas edit',
    canvas: 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV',
    expectedRevision: 'crdt-abc123',
    payload: '{"code":"update(n7,{x:1})"}',
  };

  test('stable across runs', () => {
    const a = deriveIdempotencyKey(base);
    const b = deriveIdempotencyKey({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^ik_[0-9a-f]{64}$/);
  });

  test('changes when the revision changes (intentional identical edit against new state)', () => {
    expect(deriveIdempotencyKey(base)).not.toBe(deriveIdempotencyKey({ ...base, expectedRevision: 'crdt-def456' }));
  });

  test('changes when the payload changes', () => {
    expect(deriveIdempotencyKey(base)).not.toBe(deriveIdempotencyKey({ ...base, payload: '{"code":"other"}' }));
  });

  test('changes across commands and canvases; undefined revision hashes as empty', () => {
    expect(deriveIdempotencyKey(base)).not.toBe(deriveIdempotencyKey({ ...base, command: 'canvas markup' }));
    expect(deriveIdempotencyKey(base)).not.toBe(deriveIdempotencyKey({ ...base, canvas: 'cvs_OTHER0000000000000000000000' }));
    const noRev = deriveIdempotencyKey({ ...base, expectedRevision: undefined });
    expect(noRev).not.toBe(deriveIdempotencyKey(base));
    expect(noRev).toMatch(/^ik_[0-9a-f]{64}$/);
  });
});
