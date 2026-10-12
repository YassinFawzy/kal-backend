/**
 * Unit spec — the exercise catalog projection (w4 note §2 read shapes):
 * the served member set is EXACTLY the projection's keys — HD-26 discipline
 * is structural (no media field exists in the type, so no media key can be
 * serialized), and the fixture-required members are always present.
 */
import { describe, expect, it } from 'vitest';
import { EXERCISE_PROJECTION_KEYS, projectExercise } from './catalog.projection.js';
import { SEED_EXERCISES } from '../../../prisma/seed-exercises.js';

describe('exercise catalog projection', () => {
  it('projects every manifest row with the exact pinned key set (HD-26: no media key)', () => {
    const MEDIA_KEY_PATTERN = /(image|video|media|photo|thumbnail|\burl\b|gif|embed)/iu;
    for (const exercise of SEED_EXERCISES) {
      const projected = projectExercise(exercise);
      // The structural HD-26 proof: the served member set is EXACTLY the
      // pinned projection keys — no media key exists to serialize.
      expect(Object.keys(projected).sort(), exercise.id).toEqual([...EXERCISE_PROJECTION_KEYS].sort());
      for (const key of Object.keys(projected)) {
        expect(MEDIA_KEY_PATTERN.test(key), `${exercise.id} key "${key}"`).toBe(false);
      }
    }
  });

  it('serves the fixture-required members on every row (w4 EXERCISE_ITEM_SCHEMA)', () => {
    for (const exercise of SEED_EXERCISES) {
      const projected = projectExercise(exercise) as unknown as Record<string, unknown>;
      for (const required of ['id', 'provenance', 'nameEn', 'nameAr', 'muscleGroups', 'tags']) {
        expect(projected[required], `${exercise.id}.${required}`).toBeDefined();
      }
    }
  });

  it('copies array fields (mutation of the projection cannot reach the source row)', () => {
    const source = SEED_EXERCISES[0]!;
    const projected = projectExercise(source);
    (projected.aliases as string[]).push('mutated');
    (projected.tags as string[]).push('mutated');
    expect(source.aliases).not.toContain('mutated');
    expect(source.tags).not.toContain('mutated');
  });
});
