/**
 * The import's strict JSON schemas (server/ai/import.ts formatOf), as each provider takes them.
 *
 * The import builds one flat schema per call: objects with every field required and additionalProperties false, arrays
 * of strings or of such objects, string enums, and the plain types string, integer, number and boolean. That subset is
 * inside what Meta, OpenAI (strict json_schema, Responses API and Codex --output-schema) and Claude (output_config
 * format, Claude Code --json-schema) all accept, so the translation is mechanical: the same schema, in each provider's
 * wrapper. Keywords Claude's structured outputs do not take (numeric and string-length constraints, array size limits)
 * are dropped; the import's schemas have none today, and `issues` says so in a unit test.
 */

type Json = Record<string, any>;

/** Claude's structured outputs reject these (see the Claude API docs, "JSON Schema Limitations"). */
const CLAUDE_UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems'];

/** A deep copy of a schema without the given keywords, everywhere. */
function without(schema: unknown, keywords: readonly string[]): unknown {
  if (Array.isArray(schema)) return schema.map(x => without(x, keywords));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema as Json)) {
    if (keywords.includes(k)) continue;
    // Inside "properties" the keys are field names, not keywords: keep them all.
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Json).map(([name, s]) => [name, without(s, keywords)])) : without(v, keywords);
  }
  return out;
}

/** Meta's /responses text.format, as server/ai/import.ts sends it. */
export const metaFormat = (name: string, schema: Json) => ({ type: 'json_schema', name, schema, strict: true });

/** OpenAI's Responses API text.format (strict): the same wrapper as Meta's. */
export const openaiFormat = (name: string, schema: Json) => ({ type: 'json_schema', name, schema, strict: true });

/** Codex --output-schema takes the bare schema (it is sent as strict json_schema). */
export const codexSchema = (schema: Json) => schema;

/** Claude: output_config.format = { type: 'json_schema', schema }, and Claude Code's --json-schema takes the bare schema. */
export const claudeSchema = (schema: Json) => without(schema, CLAUDE_UNSUPPORTED) as Json;
export const claudeFormat = (schema: Json) => ({ type: 'json_schema' as const, schema: claudeSchema(schema) });

/**
 * What a strict schema breaks, as JSON paths: an object that allows extra fields or leaves a field optional, or a
 * keyword the target does not take. Empty means every provider accepts it as it is.
 */
export function issues(schema: unknown, target: 'strict' | 'claude' = 'strict', path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Json;
  const found: string[] = [];
  if (target === 'claude') for (const k of CLAUDE_UNSUPPORTED) if (k in s) found.push(`${path}: ${k} is not supported by Claude`);
  if (s.type === 'object') {
    if (s.additionalProperties !== false) found.push(`${path}: additionalProperties is not false`);
    const props = Object.keys(s.properties ?? {});
    const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
    for (const p of props) if (!required.has(p)) found.push(`${path}.${p}: not required`);
    for (const p of props) found.push(...issues(s.properties[p], target, `${path}.${p}`));
  }
  if (s.type === 'array') found.push(...issues(s.items, target, `${path}[]`));
  if ('enum' in s && (!Array.isArray(s.enum) || s.enum.some((v: unknown) => typeof v !== 'string'))) found.push(`${path}: enum of non-strings`);
  return found;
}
