/**
 * The compatibility policy, as a test.
 *
 * `package.json` carries the declared range and the versions this repository has
 * actually been verified against; `src/opencode-bin.ts` carries the gate that
 * enforces it. A declared range that drifts away from the code's gate would be
 * worse than no range at all — it would be a promise nothing checks — so the two
 * are asserted to agree here, and `scripts/check-opencode-version.sh` is what
 * holds both to a real binary.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MIN_MAJOR_VERSION } from '../src/opencode-bin.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { opencodeVersion: { range: string; tested: string[]; note: string } };

const majorOf = (version: string): number => Number.parseInt(version.split('.')[0] ?? '', 10);

describe('the opencode compatibility policy', () => {
  it('declares a range that the code gate actually enforces', () => {
    expect(pkg.opencodeVersion.range).toBe(`>=${MIN_MAJOR_VERSION}.0.0`);
  });

  it('only claims versions the gate would accept', () => {
    expect(pkg.opencodeVersion.tested.length).toBeGreaterThan(0);
    for (const version of pkg.opencodeVersion.tested) {
      expect(Number.isFinite(majorOf(version))).toBe(true);
      expect(majorOf(version)).toBeGreaterThanOrEqual(MIN_MAJOR_VERSION);
    }
  });

  it('says why v1 is out, because "unsupported" alone invites a bug report', () => {
    expect(pkg.opencodeVersion.note).toMatch(/v1/);
  });
});
