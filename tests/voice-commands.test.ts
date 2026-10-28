import { describe, expect, it } from 'vitest';
import { count, matchCommand } from '../src/voice/commands.ts';

describe('matchCommand', () => {
  it('moves between steps', () => {
    for (const said of ['next', 'Next.', 'next step', 'Okay, next step please', 'go to the next step', 'Next one', '下一步']) {
      expect(matchCommand(said), said).toEqual([{ type: 'nextStep' }]);
    }
    for (const said of ['back', 'Go back.', 'previous step', 'go back one step', 'the previous one', '上一步']) {
      expect(matchCommand(said), said).toEqual([{ type: 'previousStep' }]);
    }
  });

  it('sets the replicates', () => {
    expect(matchCommand('Make it triplicates')).toEqual([{ type: 'setReplicates', replicates: 3 }]);
    expect(matchCommand('in duplicate')).toEqual([{ type: 'setReplicates', replicates: 2 }]);
    expect(matchCommand('Duplicates.')).toEqual([{ type: 'setReplicates', replicates: 2 }]);
    expect(matchCommand("let's do it in triplicate")).toEqual([{ type: 'setReplicates', replicates: 3 }]);
    expect(matchCommand('three replicates')).toEqual([{ type: 'setReplicates', replicates: 3 }]);
    expect(matchCommand('20 replicates')).toBeNull();
  });

  it('sets the number of samples', () => {
    expect(matchCommand('12 samples')).toEqual([{ type: 'setSamples', samples: 12 }]);
    expect(matchCommand('Twelve samples.')).toEqual([{ type: 'setSamples', samples: 12 }]);
    expect(matchCommand('I have twenty-four samples')).toEqual([{ type: 'setSamples', samples: 24 }]);
    expect(matchCommand('for samples')).toEqual([{ type: 'setSamples', samples: 4 }]);
    expect(matchCommand('one sample')).toEqual([{ type: 'setSamples', samples: 1 }]);
    expect(matchCommand('500 samples')).toBeNull();
    expect(matchCommand('0 samples')).toBeNull();
  });

  it('marks a standard vial done by its letter', () => {
    expect(matchCommand('A is OK')).toEqual([{ type: 'markDone', id: 'A' }]);
    expect(matchCommand('B is okay.')).toEqual([{ type: 'markDone', id: 'B' }]);
    expect(matchCommand('C is done')).toEqual([{ type: 'markDone', id: 'C' }]);
    expect(matchCommand('D done')).toEqual([{ type: 'markDone', id: 'D' }]);
    expect(matchCommand("E's done")).toEqual([{ type: 'markDone', id: 'E' }]);
    expect(matchCommand('vial F done')).toEqual([{ type: 'markDone', id: 'F' }]);
    expect(matchCommand('mark G as done')).toEqual([{ type: 'markDone', id: 'G' }]);
    expect(matchCommand('Bee is done')).toEqual([{ type: 'markDone', id: 'B' }]);
    expect(matchCommand('I is done')).toEqual([{ type: 'markDone', id: 'I' }]);
    expect(matchCommand('A and B are done')).toEqual([{ type: 'markDone', id: 'A' }, { type: 'markDone', id: 'B' }]);
  });

  it('leaves anything unsure to the server', () => {
    for (const said of [
      '',
      'what is next?',
      "what's next",
      'next to the plate reader',
      'A is done?',
      'I done',
      "I'm done",
      'be done',
      'all done',
      'it is done',
      'J is done',
      'how many samples',
      'with 12 samples',
      'how long do 12 samples take',
      'I just got a Pierce BCA protein assay kit. Help me run it',
    ]) {
      expect(matchCommand(said), said).toBeNull();
    }
  });
});

describe('count', () => {
  it('reads digits and number words', () => {
    expect(count('12')).toBe(12);
    expect(count('twelve')).toBe(12);
    expect(count('ninety six')).toBe(96);
    expect(count('twenty')).toBe(20);
    expect(count('twenty to')).toBeNull();
    expect(count('many')).toBeNull();
  });
});
