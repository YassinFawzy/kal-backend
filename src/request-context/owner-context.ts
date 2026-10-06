/**
 * Kal — owner context types and fail-closed resolution semantics (I2).
 *
 * Requests and jobs carry a validated owner context. Absent, invalid, or
 * ambiguous ⇒ the operation is refused; there is no default tenant. The
 * refusal is one generic outcome for all three failure classes (I7: the
 * denial must not become an oracle about what was wrong or what exists).
 */

export type OwnerContextKind = 'consumer' | 'vendor_branch' | 'driver' | 'admin';

export interface OwnerContext {
  readonly kind: OwnerContextKind;
  /** The owning principal's id (consumer id / branch id / driver id / admin actor id). */
  readonly ownerId: string;
}

export type OwnerResolution =
  | { readonly status: 'resolved'; readonly context: OwnerContext }
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly reason: string };

export const OWNER_KINDS: readonly OwnerContextKind[] = [
  'consumer',
  'vendor_branch',
  'driver',
  'admin',
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Validates candidate owner identifiers into a resolution (W1 reference
 * implementation of the semantics; W2's identity resolver builds on this).
 * - zero candidates ⇒ absent
 * - one syntactically valid candidate ⇒ resolved
 * - several distinct candidates ⇒ ambiguous
 * - anything malformed (shape, kind, or id) ⇒ invalid
 * `reason` strings are for internal logs only — never for responses (I7).
 */
export function resolveOwnerCandidates(
  kind: OwnerContextKind,
  candidates: readonly string[],
): OwnerResolution {
  if (candidates.length === 0) {
    return { status: 'absent' };
  }
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    return { status: 'ambiguous', reason: 'multiple distinct owner candidates' };
  }
  const ownerId = distinct[0] as string;
  if (!isUuid(ownerId)) {
    return { status: 'invalid', reason: 'owner id is not a uuid' };
  }
  return { status: 'resolved', context: { kind, ownerId } };
}

/** A synthetic fixture-range UUID for tests — never a real account. */
export function fixtureOwnerUuid(suffix: string): string {
  const hex = suffix.replace(/[^0-9a-f]/giu, '').slice(0, 12).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
