/**
 * Kal — wire projection for the exercise catalog (w4 contract note §2 read
 * shapes: `journal.exercises.search` items and `journal.exercises.get`
 * detail share ONE projection).
 *
 * HD-26 DISCIPLINE IS STRUCTURAL: this type has NO media field — no image,
 * video, URL, or placeholder implying future media exists anywhere in the
 * catalog shape (license-free text-first posture; the w4 contract note
 * freezes "no media fields exist in the catalog shape").
 *
 * The projection serves exactly the fixture-required members (`id`,
 * `provenance`, `nameEn`, `nameAr`, `muscleGroups`, `tags`) plus the detail
 * contract's aliases + bilingual text instructions — the same full item the
 * client caches online (store v4 `exercise_cache` payload: names, aliases,
 * instructions, taxonomy; contract note §9).
 */

/** The minimal row shape the projection consumes (raw SQL row or typed client row). */
export interface ExerciseCatalogSource {
  readonly id: string;
  readonly provenance: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly aliases: readonly string[];
  readonly instructionsEn: string;
  readonly instructionsAr: string;
  readonly muscleGroups: readonly string[];
  readonly tags: readonly string[];
}

export interface ExerciseItemProjection {
  readonly id: string;
  readonly provenance: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly aliases: readonly string[];
  readonly instructionsEn: string;
  readonly instructionsAr: string;
  readonly muscleGroups: readonly string[];
  readonly tags: readonly string[];
}

/** The exact served member set — pinned by tests (HD-26: no media key can appear). */
export const EXERCISE_PROJECTION_KEYS: readonly string[] = [
  'id',
  'provenance',
  'nameEn',
  'nameAr',
  'aliases',
  'instructionsEn',
  'instructionsAr',
  'muscleGroups',
  'tags',
];

export function projectExercise(exercise: ExerciseCatalogSource): ExerciseItemProjection {
  return {
    id: exercise.id,
    provenance: exercise.provenance,
    nameEn: exercise.nameEn,
    nameAr: exercise.nameAr,
    aliases: [...exercise.aliases],
    instructionsEn: exercise.instructionsEn,
    instructionsAr: exercise.instructionsAr,
    muscleGroups: [...exercise.muscleGroups],
    tags: [...exercise.tags],
  };
}
