import { describe, expect, it } from 'vitest';
import { formatOf, INTRO } from '../server/ai/import.ts';
import { CALLS, schemaName, schemaOf } from '../scripts/bench/core.ts';
import { pipelineOf } from '../scripts/bench/core.ts';
import { withReuse, current, sweep } from '../scripts/bench/plan.ts';
import { claudeFormat, claudeSchema, codexSchema, issues, metaFormat, openaiFormat } from '../scripts/bench/schema.ts';

describe('the benchmark schema adapters', () => {
  it('send Meta exactly what the import sends', () => {
    expect(metaFormat(schemaName('intro'), schemaOf('intro'))).toEqual(formatOf('ChappIntro', INTRO));
  });

  it.each(CALLS)('keep the %s schema strict and unchanged for every provider', call => {
    const schema = schemaOf(call);
    expect(issues(schema, 'strict')).toEqual([]);
    expect(issues(schema, 'claude')).toEqual([]);
    expect(claudeSchema(schema)).toEqual(schema);
    expect(claudeFormat(schema)).toEqual({ type: 'json_schema', schema });
    expect(codexSchema(schema)).toBe(schema);
    expect(openaiFormat(schemaName(call), schema)).toEqual(metaFormat(schemaName(call), schema));
  });

  it('drop what Claude does not take, but not fields that happen to share a keyword name', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['minimum', 'name', 'tags'],
      properties: {
        minimum: { type: 'number', minimum: 0, maximum: 10 },
        name: { type: 'string', maxLength: 20 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    };
    expect(issues(schema, 'claude')).toHaveLength(4);
    const out = claudeSchema(schema);
    expect(issues(out, 'claude')).toEqual([]);
    expect(Object.keys(out.properties)).toEqual(['minimum', 'name', 'tags']);
    expect(out.properties.minimum).toEqual({ type: 'number' });
  });

  it('say when an object is not strict', () => {
    const loose = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } };
    expect(issues(loose)).toEqual(['$: additionalProperties is not false', '$.b: not required']);
  });
});

describe('the benchmark pipeline times', () => {
  it('add the inventory to the slowest of the three that follow it, with the intro beside the inventory', () => {
    const p = pipelineOf({ intro: 9.5, inventory: 27.8, steps: 20.3, curves: 7.4, notes: 5.1 });
    expect(p.original).toEqual({ stepsVisible: 48.1, total: 48.1 });
    expect(p.current).toEqual({ stepsVisible: 9.5, total: 48.1 });
    expect(pipelineOf({ intro: 40, inventory: 20, steps: 10, curves: 5, notes: 5 }).current.total).toBe(50);
    expect(pipelineOf({ intro: 9, inventory: null, steps: 10, curves: 5, notes: 5 }).original.total).toBeNull();
  });

  it('reuse only the calls a sweep would ask exactly as the current run did', () => {
    const m = { provider: 'claude-cli', model: 'claude-opus-5-5', lowest: 'low', levels: ['low'] };
    expect(withReuse(sweep(m, 'low'), current(m)).reuse).toEqual({ key: 'claude-cli/claude-opus-5-5/current#1', calls: ['intro', 'inventory', 'steps'] });
    const meta = { provider: 'meta', model: 'muse-spark-1.3', lowest: 'minimal', levels: ['minimal'] };
    // Meta's current run reads the inventory at low: nothing after it can be copied into the all-minimal sweep.
    expect(withReuse(sweep(meta, 'minimal'), current(meta)).reuse).toEqual({ key: 'meta/muse-spark-1.3/current#1', calls: ['intro'] });
  });
});
