/**
 * Minimal conformance checker for the served contract fixtures' bodySchema
 * subset (conventions.md §6.1: type(object), required, properties, const,
 * items — deliberately tiny). Also rejects keywords OUTSIDE the subset so
 * the served document cannot grow unapproved complexity.
 */

export interface SchemaNode {
  readonly type?: 'object';
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly const?: unknown;
}

import { expect } from 'vitest';

const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set(['type', 'required', 'properties', 'items', 'const']);

/** Asserts `node` uses only subset keywords; throws with the offending path. */
export function assertSchemaUsesSubsetOnly(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`schema at ${path} is not an object`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`schema at ${path} uses non-subset keyword "${key}"`);
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        assertSchemaUsesSubsetOnly(child, `${path}.properties.${childKey}`);
      }
    }
    if (key === 'items') {
      assertSchemaUsesSubsetOnly(value, `${path}.items`);
    }
  }
  const type = (node as SchemaNode).type;
  if (type !== undefined && type !== 'object') {
    throw new Error(`schema at ${path} uses unsupported type "${String(type)}"`);
  }
}

/** Validates `value` against the subset schema (subset of JSON Schema semantics). */
export function assertConformsToSchema(value: unknown, node: SchemaNode, path: string): void {
  if ('const' in node && node['const'] !== undefined) {
    expect(value).toBe(node['const']);
    return;
  }
  if (node.type === 'object') {
    expect(value, `body at ${path} is an object`).toEqual(expect.any(Object));
    const record = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      expect(record, `body at ${path} has required key "${key}"`).toHaveProperty(key);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (record[key] !== undefined) {
        assertConformsToSchema(record[key], child, `${path}.${key}`);
      }
    }
    return;
  }
  if (node.items !== undefined) {
    expect(Array.isArray(value), `body at ${path} is an array`).toBe(true);
    (value as unknown[]).forEach((item, index) => assertConformsToSchema(item, node.items as SchemaNode, `${path}[${index}]`));
    return;
  }
  throw new Error(`schema at ${path} has no constraints (empty schema node)`);
}
