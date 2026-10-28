/**
 * Plate-reader exports read without a model: the same code on the phone (a file picked on Run-Read) and on the server
 * (the file again, or an .xlsx turned into text first, before Muse Spark is asked). Deterministic, so the same file
 * always gives the same wells.
 *
 * Two layouts cover the readers' text exports:
 *   grid  the plate drawn as 8 rows × 12 columns: a header row 1…12 and rows that start with their letter (Gen5,
 *         Tecan i-control and Magellan, SpectraMax / SoftMax Pro), or rows without letters under the header (SoftMax
 *         Pro's "Plate" format, which puts the temperature in front of row A), or letters without a header
 *   list  one well per line: a "Well" column (A1 or A01) and the reading beside it (SoftMax Pro's column format, BMG
 *         MARS, "Well,Value" files), or separate row and column columns
 * with any metadata around them (reader, date, wavelength, temperature, "~End"). Cells are split on tabs, semicolons,
 * commas or runs of spaces; with tabs or semicolons a decimal comma (0,123) is read as a point. A cell that holds text
 * where a reading belongs ("OVRFLW", "OVER", "?????") is kept as odd rather than dropped, so the app can show it.
 */

export type PlateLayout = 'grid' | 'list';

export type PlateRead = {
  /** Readings by well id ("A1", never "A01"), for every well the file has a number for. */
  values: Record<string, number>;
  /** Wells whose cell holds something other than a number, as written ("OVRFLW"). */
  odd: Record<string, string>;
  layout: PlateLayout;
  /** How many plate reads (grids, or repeats of the well list) the file holds; one of them is used. */
  reads: number;
  /** The words around the read used ("Read 1:562", "Raw Data (562)"), to tell the user which one it was. */
  label: string;
};

export type PlateTextOptions = {
  rows?: number;
  cols?: number;
  /** The protocol's wavelength (nm): with several reads in one file, the one that names it is preferred. */
  wavelength?: number;
};

const LETTERS = 'ABCDEFGHIJKLMNOP';

/** "A01", "a1", "A 1" → "A1"; null when it is not a well on a plate of this size. */
export function wellId(text: string, rows = 8, cols = 12): string | null {
  const m = /^([A-Pa-p])\s*0*(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const row = m[1]!.toUpperCase();
  const col = Number(m[2]);
  if (LETTERS.indexOf(row) >= rows || col < 1 || col > cols) return null;
  return `${row}${col}`;
}

/** A reading as readers write it: 0.1234, .1234, 1.234E-01, and 0,1234 where commas are not the separator. */
export function readingOf(cell: string, decimalComma: boolean): number | null {
  let s = cell.trim();
  if (decimalComma && /^[-+]?\d*,\d+(?:[eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.');
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type Line = { cells: string[]; decimalComma: boolean; blank: boolean };

/** One CSV line into cells, with double quotes around cells that hold commas ("1,234" stays one cell). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

function splitLine(raw: string): Line {
  const line = raw.replace(/^﻿/, '');
  let cells: string[];
  let decimalComma = true;
  if (line.includes('\t')) cells = line.split('\t');
  else if (line.includes(';')) cells = line.split(';');
  else if (line.includes(',')) {
    cells = csvCells(line);
    decimalComma = false;
  } else cells = line.trim().split(/\s+/);
  cells = cells.map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
  return { cells, decimalComma, blank: cells.every(c => c === '') };
}

/** Text in a reading's place that still says something about the well: overflow, saturation, a reader's error mark. */
const isOddText = (s: string) => s !== '' && !/^(?:-|—|n\/?a|nan)$/i.test(s);

/** The column header "1 2 3 … k" in a line: where "1" sits and how many columns follow it in order. */
function headerAt(cells: string[], cols: number): { at: number; count: number } | null {
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== '1') continue;
    let k = 1;
    while (k < cols && cells[i + k] === String(k + 1)) k++;
    if (k >= 3) return { at: i, count: k };
  }
  return null;
}

type Grid = { values: Record<string, number>; odd: Record<string, string>; label: string; end: number };

/** The letter cell in front of the readings, if any ("A", or "A" after a blank cell). */
function rowLetter(cells: string[], before: number, rows: number): string | null {
  for (let i = 0; i < before; i++) {
    const c = cells[i]!.toUpperCase();
    if (/^[A-P]$/.test(c) && LETTERS.indexOf(c) < rows) return c;
  }
  return null;
}

/**
 * Reads the rows of one grid whose readings sit at `positions` (cell indexes for columns 1…n), from line `from` on.
 * Rows carry their letter, or take the next one in order when the export leaves letters out (SoftMax Pro); once
 * rows have letters, an unlettered line between them is a second line about the same row (Gen5's "Conc/Dil") and is
 * skipped. Stops at a blank line, at a line with no readings, or after `rows` rows.
 */
function readGrid(lines: Line[], from: number, positions: (i: number) => number, count: number, rows: number, labelBefore: string): Grid {
  const values: Record<string, number> = {};
  const odd: Record<string, string> = {};
  let next = 0;
  let lettered: boolean | null = null;
  let trailing = '';
  let i = from;
  for (; i < lines.length && next < rows; i++) {
    const { cells, decimalComma, blank } = lines[i]!;
    if (blank) {
      if (next === 0) continue;
      break;
    }
    // Split on spaces, a row's letter takes the place the header left blank: the readings start one cell later.
    let shift = 0;
    let letter = rowLetter(cells, positions(0), rows);
    if (letter === null && /^[A-Pa-p]$/.test(cells[positions(0)] ?? '') && LETTERS.indexOf(cells[positions(0)]!.toUpperCase()) < rows) {
      letter = cells[positions(0)]!.toUpperCase();
      shift = 1;
    }
    if (lettered === null) lettered = letter !== null;
    if (lettered && letter === null) continue;
    // A letter again, or going back: another table (or a list of wells) starts here.
    if (letter !== null && LETTERS.indexOf(letter) < next) break;
    const slots = Array.from({ length: count }, (_, c) => cells[positions(c) + shift] ?? '');
    const nums = slots.map(s => readingOf(s, decimalComma));
    if (!nums.some(n => n !== null) && !slots.some(isOddText)) break;
    // A row of names (a layout grid) has no readings at all; text mixed in with readings is an odd well.
    if (!nums.some(n => n !== null)) {
      if (letter) {
        next = LETTERS.indexOf(letter) + 1;
        continue;
      }
      break;
    }
    const row = letter ?? LETTERS[next]!;
    next = LETTERS.indexOf(row) + 1;
    slots.forEach((s, c) => {
      const well = `${row}${c + 1}`;
      if (nums[c] !== null) values[well] = nums[c]!;
      else if (isOddText(s)) odd[well] = s;
    });
    if (!trailing) trailing = cells.slice(positions(count - 1) + shift + 1).filter(Boolean).join(' ');
  }
  return { values, odd, label: [labelBefore, trailing].filter(Boolean).join(' · '), end: i };
}

/**
 * Up to three non-blank lines above `at`, and any words on the header line itself, as one label. A line with
 * readings on it belongs to the read before, so the label stops there.
 */
function labelAbove(lines: Line[], at: number, header?: string[]): string {
  const words: string[] = [];
  for (let i = at - 1, n = 0; i >= 0 && n < 3; i--) {
    if (lines[i]!.blank) continue;
    if (lines[i]!.cells.filter(c => readingOf(c, lines[i]!.decimalComma) !== null).length >= 2) break;
    words.unshift(lines[i]!.cells.filter(Boolean).join(' '));
    n++;
  }
  if (header) words.push(header.filter(c => c && !/^\d+$/.test(c) && c !== '<>').join(' '));
  return words.filter(Boolean).join(' · ').slice(0, 200);
}

function findGrids(lines: Line[], rows: number, cols: number): Grid[] {
  const grids: Grid[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { cells, blank } = lines[i]!;
    if (blank) continue;
    const head = headerAt(cells, cols);
    if (head) {
      const g = readGrid(lines, i + 1, c => head.at + c, head.count, rows, labelAbove(lines, i, cells));
      if (Object.keys(g.values).length) {
        grids.push(g);
        i = g.end - 1;
      }
      continue;
    }
    // Rows with their letters and no header above: "A, 0.098, 0.101, …".
    const first = cells.findIndex(c => c !== '');
    const numbers = cells.slice(first + 1).filter(c => readingOf(c, lines[i]!.decimalComma) !== null).length;
    if (first >= 0 && /^[Aa]$/.test(cells[first]!) && numbers >= 3) {
      const g = readGrid(lines, i, c => first + 1 + c, Math.min(cols, cells.length - first - 1), rows, labelAbove(lines, i));
      // Without a header, it takes two rows (A, B…) or a long row A to be a plate, not a list that starts at A.
      const rowsRead = new Set([...Object.keys(g.values), ...Object.keys(g.odd)].map(w => w[0])).size;
      if (rowsRead >= 2 || Object.keys(g.values).length >= 6) {
        grids.push(g);
        i = g.end - 1;
      }
    }
  }
  return grids;
}

// ─── One well per line ───────────────────────────────────────────────────────────────────────────────────────────

const GOOD_HEAD = /abs|\bod\b|raw|value|result|reading|meas|signal|data/i;
const BAD_HEAD = /conc|temp|time|mean|avg|average|\bsd\b|std\.? ?dev|\bcv\b|%|blank|corr|dilut|^row$|^col(umn)?$|index|^wavelength|^\s*nm\s*$|well ?(row|col)|content|sample|type|group|name|id$/i;

function findList(lines: Line[], rows: number, cols: number, wavelength?: number): Grid & { reads: number } | null {
  type Hit = { line: number; well: string; cells: string[]; decimalComma: boolean; wellCol: number };
  const hits: Hit[] = [];
  let header: { cells: string[]; at: number } | null = null;
  let rowCol = -1;
  let colCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const { cells, decimalComma, blank } = lines[i]!;
    if (blank) continue;
    const named = cells.findIndex(c => /^wells?(?:\s*(?:id|position|pos\.?|name))?$/i.test(c));
    if (named >= 0 && !cells.some((c, j) => j !== named && wellId(c, rows, cols))) {
      header = { cells, at: i };
      rowCol = cells.findIndex(c => /^(?:well\s*)?row$/i.test(c));
      colCol = cells.findIndex(c => /^(?:well\s*)?col(?:umn)?$/i.test(c));
      continue;
    }
    if (!header) {
      const r = cells.findIndex(c => /^(?:well\s*)?row$/i.test(c));
      const c = cells.findIndex(x => /^(?:well\s*)?col(?:umn)?$/i.test(x));
      if (r >= 0 && c >= 0) {
        header = { cells, at: i };
        rowCol = r;
        colCol = c;
        continue;
      }
    }
    let wellCol = cells.findIndex(c => wellId(c, rows, cols) !== null);
    let well = wellCol >= 0 ? wellId(cells[wellCol]!, rows, cols) : null;
    if (!well && rowCol >= 0 && colCol >= 0) {
      well = wellId(`${cells[rowCol] ?? ''}${cells[colCol] ?? ''}`, rows, cols);
      wellCol = Math.max(rowCol, colCol);
    }
    if (!well) continue;
    if (!cells.some((c, j) => j !== wellCol && j !== rowCol && j !== colCol && readingOf(c, decimalComma) !== null)) continue;
    hits.push({ line: i, well, cells, decimalComma, wellCol });
  }
  if (hits.length < 3) return null;

  // The reading column: the header's best name for one ("Raw Data (562)", "Abs", "Value"), else the first column
  // that has a number on most lines and is not a count, an index or the wavelength repeated.
  const width = Math.max(...hits.map(h => h.cells.length));
  const candidates: { col: number; score: number }[] = [];
  for (let col = 0; col < width; col++) {
    if (hits.every(h => h.wellCol === col) || col === rowCol || col === colCol) continue;
    const nums = hits.map(h => readingOf(h.cells[col] ?? '', h.decimalComma));
    const filled = nums.filter((n): n is number => n !== null);
    if (filled.length < hits.length / 2) continue;
    const integers = filled.every(n => Number.isInteger(n));
    if (integers && (filled.every(n => n === filled[0]) || filled.every(n => n >= 0 && n <= 384))) continue;
    const head = header?.cells[col] ?? '';
    let score = 0;
    if (GOOD_HEAD.test(head)) score += 2;
    if (wavelength && head.includes(String(wavelength))) score += 3;
    if (BAD_HEAD.test(head) && !(wavelength && head.includes(String(wavelength)))) score -= 4;
    candidates.push({ col, score });
  }
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const values: Record<string, number> = {};
  const odd: Record<string, string> = {};
  const times: Record<string, number> = {};
  for (const h of hits) {
    times[h.well] = (times[h.well] ?? 0) + 1;
    if (times[h.well]! > 1) continue;
    const cell = h.cells[best.col] ?? '';
    const n = readingOf(cell, h.decimalComma);
    if (n !== null) values[h.well] = n;
    else if (isOddText(cell)) odd[h.well] = cell;
  }
  const label = [header ? labelAbove(lines, header.at) : '', header?.cells[best.col] ?? ''].filter(Boolean).join(' · ');
  return { values, odd, label, end: hits.at(-1)!.line + 1, reads: Math.max(...Object.values(times)) };
}

/** A read worth less than another: a layout, concentrations, or values already blank-corrected or divided. */
const SECOND_CHOICE = /layout|well ?id|conc|dil|blank|corr|delta|ratio|calc|result|fit|std ?curve/i;

/**
 * The plate in a reader's text export, or null when there is none. With several reads in one file (two wavelengths,
 * raw and blank-corrected), the one that names `wavelength` and is not a derived table wins, else the first.
 */
export function parsePlateText(text: string, options: PlateTextOptions = {}): PlateRead | null {
  const { rows = 8, cols = 12, wavelength } = options;
  const lines = text.split(/\r\n|\r|\n/).map(splitLine);
  const grids = findGrids(lines, rows, cols);
  if (grids.length) {
    const score = (g: Grid) => (wavelength && g.label.includes(String(wavelength)) ? 2 : 0) - (SECOND_CHOICE.test(g.label) ? 3 : 0);
    const chosen = grids.reduce((a, b) => (score(b) > score(a) ? b : a));
    return { values: chosen.values, odd: chosen.odd, layout: 'grid', reads: grids.length, label: chosen.label };
  }
  const list = findList(lines, rows, cols, wavelength);
  if (list && Object.keys(list.values).length) return { values: list.values, odd: list.odd, layout: 'list', reads: list.reads, label: list.label };
  return null;
}

/**
 * A text export's bytes as text: UTF-8, UTF-16 (SoftMax Pro writes UTF-16 LE with a byte-order mark; some readers
 * leave the mark out), or Windows-1252 when the bytes are not UTF-8 (older Windows exports: "°C", "µ").
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = bytes.subarray(0, 400);
  let oddZeros = 0;
  let evenZeros = 0;
  head.forEach((b, i) => b === 0 && (i % 2 ? oddZeros++ : evenZeros++));
  if (oddZeros > head.length / 6) return new TextDecoder('utf-16le').decode(bytes);
  if (evenZeros > head.length / 6) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ─── The plan's wells ────────────────────────────────────────────────────────────────────────────────────────────

export type PlanFit = {
  /** Readings for the plan's wells. */
  readings: Record<string, number>;
  /** The plan's wells with no reading at all. */
  missing: string[];
  /** The plan's wells whose cell held text instead of a reading. */
  odd: Record<string, string>;
  /** Wells outside the plan that have readings (ignored). */
  extra: number;
};

/** Keeps the readings of the wells the plan loaded (plateMap's cells), and says which of them have none. */
export function fitToPlan(read: { values: Record<string, number>; odd?: Record<string, string> }, wells: readonly string[]): PlanFit {
  const inPlan = new Set(wells);
  const readings: Record<string, number> = {};
  const odd: Record<string, string> = {};
  const missing: string[] = [];
  for (const w of wells) {
    const v = read.values[w];
    if (v !== undefined && Number.isFinite(v)) readings[w] = v;
    else if (read.odd?.[w] !== undefined) odd[w] = read.odd[w]!;
    else missing.push(w);
  }
  const extra = Object.keys(read.values).filter(w => !inPlan.has(w)).length;
  return { readings, missing, odd, extra };
}
