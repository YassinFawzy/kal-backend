import { describe, expect, it } from 'vitest';
import { Algorithm, hash as rawHash } from '@node-rs/argon2';
import { PasswordHasherService } from './password-hasher.service.js';
import { IdentityConfigService } from './identity.config.js';

/**
 * Hash goldens (ADR-0003): PHC storage form, argon2id parameters, round-trip
 * verification, wrong-password rejection, malformed-hash behavior, and the
 * parameter-drift detection that drives rehash-on-login.
 */

function makeHasher(env: Record<string, string> = {}): PasswordHasherService {
  const config = new IdentityConfigService('test', { NODE_ENV: 'test', ...env });
  return new PasswordHasherService(config);
}

describe('PasswordHasherService (ADR-0003)', () => {
  it('the runtime Algorithm.Argon2id value matches the constant the hasher sends', () => {
    // isolatedModules forbids const-enum member access in source; this golden
    // pins the numeric value against the binding's runtime export.
    expect(Algorithm.Argon2id).toBe(2);
  });

  it('hash produces an argon2id PHC string with the configured parameters and a unique salt', async () => {
    const hasher = makeHasher();
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
    expect(second).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
    // Unique salts: same password never yields the same PHC string.
    expect(first).not.toBe(second);
  });

  it('verify round-trips and rejects wrong passwords', async () => {
    const hasher = makeHasher();
    const phc = await hasher.hash('correct horse battery staple');
    expect(await hasher.verifyAgainst(phc, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verifyAgainst(phc, 'incorrect horse battery staple')).toBe(false);
  });

  it('a malformed or foreign PHC string behaves as a failed verification (never throws)', async () => {
    const hasher = makeHasher();
    expect(await hasher.verifyAgainst('not-a-phc-string', 'whatever')).toBe(false);
    expect(await hasher.verifyAgainst('$argon2i$v=19$m=65536,t=3,p=1$AAAA$BBBB', 'whatever')).toBe(false);
  });

  it('the dummy-verify path performs a real verification of equal shape (equalized work)', async () => {
    const hasher = makeHasher();
    // Must neither throw nor leak a result — it exists purely to consume the
    // same argon2id work on the unknown-identifier path (contract §3).
    await expect(hasher.verifyAgainstDummy('any-submitted-password')).resolves.toBeUndefined();
  });

  it('needsRehash detects parameter drift and stability (rehash-on-login trigger)', async () => {
    const hasher = makeHasher();
    const current = await hasher.hash('upgrade-path-password');
    expect(hasher.needsRehash(current)).toBe(false);

    // Old/smaller parameters (the stored form of a pre-upgrade account).
    const legacy = await rawHash('upgrade-path-password', {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(legacy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(hasher.needsRehash(legacy)).toBe(true);

    // Non-argon2id forms always report drift so they would migrate too.
    expect(hasher.needsRehash('$argon2i$v=19$m=65536,t=3,p=1$AAAA$BBBB')).toBe(true);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });

  it('a rehash upgrades the stored form to current parameters', async () => {
    const hasher = makeHasher();
    const legacy = await rawHash('upgrade-path-password', {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(await hasher.verifyAgainst(legacy, 'upgrade-path-password')).toBe(true);
    const upgraded = await hasher.rehash('upgrade-path-password');
    expect(upgraded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
    expect(await hasher.verifyAgainst(upgraded, 'upgrade-path-password')).toBe(true);
    expect(await hasher.verifyAgainst(upgraded, 'wrong-password')).toBe(false);
  });
});
