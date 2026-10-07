/**
 * Kal — password hashing service (ADR-0003, exactly).
 *
 * argon2id via `@node-rs/argon2` (the library is swappable; the algorithm
 * and parameters are the decision): 64 MiB / t=3 / p=1 by default, unique
 * random salt per hash (library-generated, never reused), PHC strings as
 * the only storage form, constant-time verification, and transparent
 * rehash-on-login when stored parameters differ from the current ones.
 *
 * Enumeration resistance (contract §3): `verifyAgainstDummy` runs a REAL
 * argon2id verification of the submitted password against a fixed dummy
 * hash on the unknown-identifier path, so "no such user" costs the same
 * work as "wrong password" — timing does not leak existence (s4 asserts
 * timing). The dummy hash uses the current parameters and guards a value
 * that was discarded at construction; it is not a credential.
 */
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';
import { IdentityConfigService } from './identity.config.js';

/**
 * `Algorithm.Argon2id` — the binding ships it as an ambient const enum,
 * which `isolatedModules` forbids accessing by member; the numeric value is
 * pinned by the binding's declaration (Argon2id = 2) and asserted in the
 * hasher unit spec via the runtime export.
 */
const ARGON2ID_ALGORITHM: Options['algorithm'] = 2;

const DUMMY_SECRET = 'kal:identity:dummy-verify-target:v1';

@Injectable()
export class PasswordHasherService {
  private readonly options: Options;
  private dummyHashPromise: Promise<string> | null = null;

  constructor(config: IdentityConfigService) {
    this.options = {
      algorithm: ARGON2ID_ALGORITHM,
      memoryCost: config.values.argon2.memoryCostKiB,
      timeCost: config.values.argon2.timeCost,
      parallelism: config.values.argon2.parallelism,
    };
  }

  /** Hashes to the encoded PHC string (argon2id, current parameters, fresh salt). */
  async hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /** Constant-time PHC verification (library-provided). */
  async verifyAgainst(phcString: string, password: string): Promise<boolean> {
    try {
      return await verify(phcString, password);
    } catch {
      // Malformed/unverifiable stored hash behaves exactly like a failed
      // verification — never a crash, never a signal (I12).
      return false;
    }
  }

  /** Equalized work for the unknown-identifier path (contract §3). */
  async verifyAgainstDummy(password: string): Promise<void> {
    if (this.dummyHashPromise === null) {
      // Lazily once per process; the PHC string embeds the current parameters
      // so the dummy path costs the same work as a real verification.
      this.dummyHashPromise = hash(DUMMY_SECRET, this.options);
    }
    await verify(await this.dummyHashPromise, password);
  }

  /**
   * True when the stored PHC string's parameters differ from the current
   * configuration (the rehash-on-login trigger — ADR-0003 upgrade path).
   * Non-argon2id or unparsable strings always report "needs upgrade", so
   * legacy forms would migrate the same way if any ever existed.
   */
  needsRehash(phcString: string): boolean {
    const match = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/u.exec(phcString);
    if (match === null) {
      return true;
    }
    const [, version, memory, time, parallelism] = match as unknown as readonly string[];
    if (version !== '19') {
      return true;
    }
    return (
      Number(memory) !== this.options.memoryCost ||
      Number(time) !== this.options.timeCost ||
      Number(parallelism) !== this.options.parallelism
    );
  }

  /** Rehashes with current parameters (only called after a successful verify). */
  async rehash(password: string): Promise<string> {
    return this.hash(password);
  }
}
