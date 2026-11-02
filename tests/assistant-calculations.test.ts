import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assemble } from '../server/ai/import.ts';
import * as protocols from '../server/ai/protocols.ts';
import { calculatePlan, runLocalTool } from '../server/ai/conversationTools.ts';
import type { ConverseContext } from '../shared/ai.ts';
import { analyzeRun } from '../src/screens/results/analysis.ts';
import { runSetup } from '../src/components/lab/model.ts';
import { parts } from './import-fixture.ts';

const protocol = assemble(parts(), { sha256: 'a'.repeat(64), pages: 2, fetchedAt: '2026-10-31T00:00:00.000Z', seconds: 1 }).protocol;
const context: ConverseContext = { screen: 'results', protocolId: protocol.id, procedure: 'plate', samples: 2, replicates: 2, standardReplicates: 2, standards: 'kit' };
const plan = { procedure: 'plate', samples: 2, replicates: 2, standardReplicates: 2, standards: 'kit' as const };
const { roles } = runSetup(protocol, plan);
const readings = Object.fromEntries(roles.map(role => [role.well, 0.1 + (role.kind === 'standard' ? role.concentration! : role.ref === '1' ? 750 : 1500) / 1000]));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(protocols, 'loadProtocol').mockImplementation(id => id === protocol.id ? protocol : null);
});

describe('read-only assistant calculations', () => {
  it('rejects a layout that needs too many columns despite fewer than 96 wells', () => {
    const result = calculatePlan({ samples: 25, replicates: 3, standardReplicates: 1 }, context).data as any;
    expect(result).toMatchObject({ wells: 78, capacity: 96, fits: false });
    expect(result.placedWells).toBeLessThan(result.wells);
    expect(result.values.reagent).toBeUndefined();
    expect(context.samples).toBe(2);
  });

  it('retains the requested count when plate edits would hide missing wells', () => {
    const result = calculatePlan({ samples: 25, replicates: 3, standardReplicates: 1 }, {
      ...context, edits: { moved: { A1: 'H12' }, added: [] },
    }).data as any;
    expect(result).toMatchObject({ wells: 78, fits: false });
    expect(result.values.plan.wells).toBe('78');
    expect(result.values.reagent).toBeUndefined();
  });

  it('computes valid differing replicate plans and rejects overlapping edits', () => {
    expect(calculatePlan({ samples: 8, replicates: 3, standardReplicates: 1 }, context).data).toMatchObject({ wells: 27, placedWells: 27, fits: true });
    expect(calculatePlan({}, { ...context, edits: { moved: { A1: 'H12', A2: 'H12' }, added: [] } }).data).toMatchObject({ fits: false });
  });

  it('returns the same concentrations and range flags as Results and labels sample data', () => {
    const result = runLocalTool('analyze_results', {}, { ...context, readings, readingsFrom: 'sample' }).data as any;
    const expected = analyzeRun(protocol, roles, readings)!;
    expect(result.samples).toEqual(expected.samples);
    expect(result.fit).toEqual(expected.fit);
    expect(result).toMatchObject({ sampleData: true, readingsFrom: 'sample', concentrationUnit: 'µg/mL', missingStandardWells: [], missingSampleWells: [] });
    expect(result.samples[0]).toMatchObject({ flag: 'ok', concentration: 750 });
    expect(result.samples[1]).toMatchObject({ flag: 'above', concentration: null });
  });

  it('discloses absent replicates and ignores readings outside the actual layout', () => {
    const partial: Record<string, number> = { ...readings, H12: 900 };
    const missing = roles.find(role => role.kind === 'sample')!.well;
    delete partial[missing];
    const result = runLocalTool('analyze_results', {}, { ...context, readings: partial, readingsFrom: 'plate' }).data as any;
    expect(result).toMatchObject({ sampleData: false, missingSampleWells: [missing], ignoredReadings: ['H12'] });
    expect(result.samples[0].cv).toBeNull();
    expect(result.note).toContain('Partial readings');
  });

  it('requires actual readings and does not silently substitute zero for an absent blank', () => {
    expect(() => runLocalTool('analyze_results', {}, context)).toThrow('no readings');
    const noBlank = Object.fromEntries(roles.filter(role => !role.blank).map(role => [role.well, readings[role.well]!]));
    expect(() => runLocalTool('analyze_results', {}, { ...context, readings: noBlank })).toThrow('blank readings are missing');
    expect(() => runLocalTool('analyze_results', { readings }, context)).toThrow();
  });

  it('keeps hypothetical cards consistent while preserving standards unless explicitly changed', () => {
    const result = runLocalTool('show_card', { kind: 'standards', replicates: 3 }, context);
    expect(result.a2ui?.[1]).toMatchObject({ updateComponents: { components: [{ component: 'StandardsCard', samples: 2, replicates: 3, standardReplicates: 2 }] } });
    expect((result.data as any).values).toMatchObject({ wells: 12, plan: { samples: 2, replicates: 3, standardReplicates: 2 } });
    for (const kind of ['standards', 'plate', 'reagent']) {
      const changed = runLocalTool('show_card', { kind, replicates: 3, standardReplicates: 1 }, context);
      expect(changed.a2ui?.[1]).toMatchObject({ updateComponents: { components: [{ samples: 2, replicates: 3, standardReplicates: 1 }] } });
      expect((changed.data as any).values).toMatchObject({ wells: 9, plan: { samples: 2, replicates: 3, standardReplicates: 1 } });
    }
    expect(context.standardReplicates).toBe(2);
    expect(context.replicates).toBe(2);
  });
});
