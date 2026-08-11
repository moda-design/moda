import { describe, expect, test } from 'bun:test';
import { redactString, redactValue } from '../src/output/redact.ts';

const RAW_KEY = `moda_live_${'ab12'.repeat(16)}`;

describe('redaction choke point', () => {
  test('moda_live_ keys never survive in any emitted string', () => {
    const poisoned = `before ${RAW_KEY} after`;
    const out = redactString(poisoned);
    expect(out).not.toContain(RAW_KEY);
    expect(out).toContain('moda_live_[REDACTED]');
  });

  test('signed-URL signature params are scrubbed, path and benign params survive', () => {
    const url = 'https://storage.googleapis.com/b/o.png?X-Goog-Signature=deadbeef123&generation=17&X-Goog-Credential=abc%2F123';
    const out = redactString(url);
    expect(out).not.toContain('deadbeef123');
    expect(out).not.toContain('abc%2F123');
    expect(out).toContain('generation=17');
    expect(out).toContain('https://storage.googleapis.com/b/o.png');
  });

  test('deep JSON redaction covers nested objects and arrays', () => {
    const body = {
      items: [{ url: 'https://x.test/a?token=SECRET111' }],
      nested: { key: RAW_KEY },
      count: 2,
      okay: true,
    };
    const out = redactValue(body);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SECRET111');
    expect(serialized).not.toContain(RAW_KEY);
    expect(out.count).toBe(2);
    expect(out.okay).toBe(true);
  });

  test('property-style: no poisoned fixture leaks through JSON serialization', () => {
    const fixtures = [
      { a: RAW_KEY },
      { b: [`x ${RAW_KEY} y`, 'clean'] },
      { c: { d: { e: `https://cdn.test/f.png?sig=SECRET222&w=100` } } },
      { msg: `Authorization: Bearer ${RAW_KEY}` },
    ];
    for (const fixture of fixtures) {
      const out = JSON.stringify(redactValue(fixture));
      expect(out).not.toContain(RAW_KEY);
      expect(out).not.toContain('SECRET222');
    }
  });
});
