/**
 * Unit spec — the recorded-fixture dev OFF adapter (the W3 seam binding): the
 * fixture barcodes resolve to attributed snapshots; everything else is a miss
 * (the pipeline then serves the success-shaped not_found). No network — ever.
 */
import { describe, expect, it } from 'vitest';
import { DevBarcodeLookupAdapter } from './dev-off.adapter.js';
import { OFF_DEV_FIXTURES } from './off-fixtures.js';

describe('DevBarcodeLookupAdapter (recorded fixtures)', () => {
  const adapter = new DevBarcodeLookupAdapter();

  it('resolves every recorded fixture with ODbL attribution attached', async () => {
    for (const fixture of OFF_DEV_FIXTURES) {
      const snapshot = await adapter.lookup(fixture.barcode);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.attribution.source).toBe('open_food_facts');
      expect(snapshot?.attribution.license).toBe('odbl');
      expect(snapshot?.attribution.contributor.length).toBeGreaterThan(0);
      expect(snapshot?.servingGrams).toBeGreaterThan(0);
    }
  });

  it('misses anything unrecorded — no live lookups, ever (task contract)', async () => {
    expect(await adapter.lookup('0000000000000')).toBeNull();
    expect(await adapter.lookup('200000009999')).toBeNull();
  });

  it('recorded fixtures are synthetic (20x in-store range; 8–14 digits per the schema CHECK)', () => {
    for (const fixture of OFF_DEV_FIXTURES) {
      expect(fixture.barcode).toMatch(/^[0-9]{8,14}$/u);
      expect(fixture.barcode.startsWith('200')).toBe(true);
    }
  });
});
