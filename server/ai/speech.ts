import * as OpenCC from 'opencc-js';
import { labTerms } from '../../src/voice/labWords.ts';
import { knownProtocols } from './protocols.ts';

/**
 * How Chapp asks Muse Voice Transcribe to listen (https://dev.meta.ai/docs/speech-to-text), for a recording
 * (POST /asr/transcribe) and live (wss /asr/realtime, see live.ts): the lab's words as keywords, Chinese (Taiwan) and
 * English in one sentence, and the words back in Traditional Chinese as used in Taiwan, since the model writes
 * Simplified whatever it is told.
 *
 * On 2026-10-30, one Taiwanese sentence ("幫我找 TRIzol，然後把 BCA 的樣本改成三重複，吸 25 微升的 working reagent"):
 * DIARIZATION with no hints, as Chapp first sent it, heard "帮我找 TRISO … C 25 维生的 Working Regent" in 3.05 s;
 * PUSH_TO_TALK with these keywords and languages heard "帮我找 TRIzol … 吸二十五微升的 working reagent" in 2.05 s.
 */

export const ASR_MODEL = 'muse-voice-transcribe-1.0';

/** A hint, not a rule: the model still hears whichever is spoken, and both in one sentence. */
export const LANGUAGES = ['Chinese (Taiwan)', 'English'];

/** What a lab says that no manual lists: reagents, methods, the bench's own words. */
const BENCH = [
  'TRIzol', 'DAPI', 'DMSO', 'PBS', 'DPBS', 'FBS', 'BSA', 'Tris', 'EDTA', 'SDS', 'trypsin', 'agarose', 'chloroform',
  'isopropanol', 'ethanol', 'PFA', 'Triton X-100', 'Tween 20', 'PCR', 'qPCR', 'Western blot', 'ELISA', 'Bradford',
  'microplate', 'plate reader', 'working reagent', 'standard curve', 'replicates', 'triplicate', 'duplicate',
  'supernatant', 'pellet', 'vortex', 'centrifuge', 'pipette', 'µL', 'mL', 'blocking buffer', 'antibody', 'primer',
  '三重複', '二重複', '微升', '毫升', '離心', '上清液', '培養', '孔盤',
];

/**
 * The keywords for one session: the bench's words, then each kit Chapp has, its vendor and its bottles. Meta refuses a
 * keyword longer than 30 characters ("ASR keyword 57 exceeds the maximum length of 30 characters", 2026-10-30; the docs
 * give no limit), so a kit's long full name is left to its shorter words.
 */
export function keywords(): string[] {
  return [...new Set([...BENCH, ...labTerms(knownProtocols())])].filter(k => k.length <= KEYWORD_MAX).slice(0, 200);
}
const KEYWORD_MAX = 30;

const taiwan = OpenCC.Converter({ from: 'cn', to: 'twp' });

const HAN = '\u3400-\u9fff';

/**
 * The model's Simplified Chinese as Taiwan writes it ("样本" → "樣本"), its commas by Chinese full-width ("TRIzol, 然後"
 * → "TRIzol，然後") and its doubled spaces closed; English and numbers stay as they are.
 */
export const toTaiwan = (text: string) =>
  taiwan(text)
    .replace(new RegExp(`\\s*,\\s*(?=[${HAN}])|(?<=[${HAN}])\\s*,\\s*`, 'g'), '，')
    .replace(/ {2,}/g, ' ');
