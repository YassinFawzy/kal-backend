/**
 * Kal — user context types and fail-closed resolution semantics (I2).
 *
 * Requests and jobs carry a validated user context. Absent, invalid, or
 * ambiguous ⇒ the operation is refused; there is no default tenant. The
 * refusal is one generic outcome for all three failure classes (I7: the
 * denial must not become an oracle about what was wrong or what exists).
 */

export type UserContextKind = 'consumer' | 'vendor_branch' | 'driver' | 'admin';

export interface UserContext {
  readonly kind: UserContextKind;
  /**
   * The principal's id on its identity plane — consumer `user_id` / vendor
   * branch `vendor_id` / driver `driver_user_id` / admin `admin_id` (I1).
   */
  readonly userId: string;
}

export type UserResolution =
  | { readonly status: 'resolved'; readonly context: UserContext }
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly reason: string };

export const USER_KINDS: readonly UserContextKind[] = [
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
 * Validates candidate user identifiers into a resolution (W1 reference
 * implementation of the semantics; W2's identity resolver builds on this).
 * - zero candidates ⇒ absent
 * - one syntactically valid candidate ⇒ resolved
 * - several distinct candidates ⇒ ambiguous
 * - anything malformed (shape, kind, or id) ⇒ invalid
 * `reason` strings are for internal logs only — never for responses (I7).
 */
export function resolveUserCandidates(
  kind: UserContextKind,
  candidates: readonly string[],
): UserResolution {
  if (candidates.length === 0) {
    return { status: 'absent' };
  }
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    return { status: 'ambiguous', reason: 'multiple distinct user candidates' };
  }
  const userId = distinct[0] as string;
  if (!isUuid(userId)) {
    return { status: 'invalid', reason: 'user id is not a uuid' };
  }
  return { status: 'resolved', context: { kind, userId } };
}

/** A synthetic fixture-range UUID for tests — never a real account. */
export function fixtureUserUuid(suffix: string): string {
  const hex = suffix.replace(/[^0-9a-f]/giu, '').slice(0, 12).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
