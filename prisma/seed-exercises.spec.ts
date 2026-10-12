/**
 * Manifest fidelity spec — exercise catalog seed (w4 contract note §8).
 *
 * Pins the seed manifest against the contract's own rules:
 *   - every hand-derived `*Normalized` form is EXACTLY what the frozen
 *     wave-03 normalization pipeline (§7 — reused, never re-specified)
 *     produces (the W3 manifest-stability rule, applied here at authoring
 *     time so the s2b catalog lane inherits a provably correct manifest);
 *   - sizing inside the 40–60 contract target; provenance `kal_reviewed`
 *     everywhere; ids unique and inside the reserved `…f2nn` fixture range;
 *   - bilingual names + text instructions present (HD-26 text-only posture —
 *     structurally, the manifest TYPE has no media field);
 *   - alias/normalized element-wise parity; taxonomy inside the DB CHECK
 *     bounds (≤ 20 elements, element length 1..40); names/instructions
 *     inside the migration's CHECK bounds.
 */
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/tracking/normalization/normalization.js';
import { SEED_EXERCISES } from './seed-exercises.js';

describe('exercise seed manifest (w4 contract note §8)', () => {
  it('sizes inside the contract target (40–60 items)', () => {
    expect(SEED_EXERCISES.length).toBeGreaterThanOrEqual(40);
    expect(SEED_EXERCISES.length).toBeLessThanOrEqual(60);
  });

  it('ids are unique, valid UUIDs in the reserved …f2nn fixture range', () => {
    const ids = SEED_EXERCISES.map((exercise) => exercise.id);
    expect(new Set(ids).size).toBe(ids.length);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}$/u;
    for (const id of ids) {
      expect(id, id).toMatch(uuid);
      expect(id.slice(24), id).toMatch(/^00000000f2[0-9a-f]{2}$/u);
    }
  });

  it('every row is kal_reviewed with bilingual names and text instructions', () => {
    for (const exercise of SEED_EXERCISES) {
      expect(exercise.provenance, exercise.id).toBe('kal_reviewed');
      expect(exercise.nameEn.trim().length, exercise.id).toBeGreaterThan(0);
      expect(exercise.nameAr.trim().length, exercise.id).toBeGreaterThan(0);
      expect(exercise.instructionsEn.trim().length, exercise.id).toBeGreaterThan(0);
      expect(exercise.instructionsAr.trim().length, exercise.id).toBeGreaterThan(0);
    }
  });

  it('hand-derived normalized forms reproduce the frozen pipeline exactly (w3 §7)', () => {
    for (const exercise of SEED_EXERCISES) {
      expect(exercise.nameEnNormalized, `${exercise.id} nameEn`).toBe(normalize(exercise.nameEn));
      expect(exercise.nameArNormalized, `${exercise.id} nameAr`).toBe(normalize(exercise.nameAr));
      expect(
        exercise.aliasesNormalized.map((alias) => alias),
        `${exercise.id} aliases`,
      ).toEqual(exercise.aliases.map((alias) => normalize(alias)));
    }
  });

  it('aliases are element-wise parity arrays inside the DB CHECK bounds', () => {
    for (const exercise of SEED_EXERCISES) {
      expect(exercise.aliases.length, exercise.id).toBe(exercise.aliasesNormalized.length);
      expect(exercise.aliases.length, exercise.id).toBeLessThanOrEqual(20);
      for (const alias of exercise.aliases) {
        expect(alias.trim().length, `${exercise.id} alias`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('taxonomy stays inside the migration CHECK bounds (≤ 20 elements, 1..40 chars)', () => {
    for (const exercise of SEED_EXERCISES) {
      expect(exercise.muscleGroups.length, exercise.id).toBeLessThanOrEqual(20);
      expect(exercise.tags.length, exercise.id).toBeLessThanOrEqual(20);
      for (const element of [...exercise.muscleGroups, ...exercise.tags]) {
        expect(element.length, `${exercise.id} taxonomy`).toBeGreaterThanOrEqual(1);
        expect(element.length, `${exercise.id} taxonomy`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('names and instructions stay inside the migration CHECK bounds', () => {
    for (const exercise of SEED_EXERCISES) {
      expect(exercise.nameEn.length, exercise.id).toBeLessThanOrEqual(200);
      expect(exercise.nameAr.length, exercise.id).toBeLessThanOrEqual(200);
      expect(exercise.instructionsEn.length, exercise.id).toBeLessThanOrEqual(2000);
      expect(exercise.instructionsAr.length, exercise.id).toBeLessThanOrEqual(2000);
    }
  });

  it('covers gym, CrossFit-style conditioning, and calisthenics categories', () => {
    const tags = new Set(SEED_EXERCISES.flatMap((exercise) => exercise.tags));
    expect(tags.has('bodyweight')).toBe(true);
    expect(tags.has('barbell')).toBe(true);
    expect(tags.has('conditioning')).toBe(true);
    const muscleGroups = new Set(SEED_EXERCISES.flatMap((exercise) => exercise.muscleGroups));
    for (const group of ['legs', 'chest', 'back', 'shoulders', 'arms', 'core']) {
      expect(muscleGroups.has(group), group).toBe(true);
    }
  });
});
