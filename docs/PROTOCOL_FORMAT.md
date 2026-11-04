# Protocol format: `chapp.protocol/1`

One JSON document per kit protocol, validated by `shared/protocol.ts`. The app draws every bench screen from it; the
numbers that depend on a particular run come from `shared/calc.ts`.

## Rules

1. **Everything is cited.** Each component, step, table and note has a `cite`: the page, plus a verbatim `quote` or the
   name of a `table` or `figure` on that page. Chapp's own wording goes in `title`, `key` and note `text`; the original
   stays in the quote.
2. **Numbers come from the source or from code.** Volumes, concentrations, times and temperatures are transcribed from
   the source. Anything that depends on the run (working reagent for N samples, which well gets what) is computed.
3. **The document has to add up.** `problems()` checks that every id resolves and that each dilution series is
   arithmetically consistent: source concentration × volume taken ÷ (taken + diluent) = the stated concentration.

## Units

Every amount is kept as the manual prints it: a number and its unit, whatever the unit is: `25 µL`, `500 nL`,
`2 mg/mL`, `10 pg/mL`, `5 µM`, `0.5 %`, `10 U/mL`. The unit is only tidied for display (`u` and the Greek μ become µ,
`ml` becomes `mL`). Nothing is converted when a manual is read. Durations are `s`, `min` or `h`, because timers count
them; days are written as hours.

The app converts only where it computes, through `shared/units.ts`: volumes (pL to L) to µL, mass concentrations
(pg to g, per µL to L) to µg/mL, molar ones (pM to M) to µM, never mass into molar. Plan, Run and Results work in µL
and µg/mL; `isPlannable()` in `shared/calc.ts` says whether a procedure's sample and reagent volumes, dilution table,
working range and additions all convert. When one does not ("the standards are in µM"), those screens say Chapp
can't work that run out and leave it to the printed protocol, as for a kit with no plate. `problems()` checks a
dilution table in whatever units put it on one scale; a unit it doesn't know is not a problem.

## Shape

| Field | What it holds |
|---|---|
| `source` | The document it was read from: title, publisher, document id and revision, URL (or, for a manual the user uploaded, `/api/protocols/<id>/manual.pdf`, Chapp's copy), SHA-256, page count |
| `kit` | Catalog variants and what each contains (count × volume per component; no volume when the source gives none, "1 vial") |
| `overview` | The source's own at-a-glance summary of one procedure |
| `components` | Bottles in the kit and things the user supplies (role, concentration, storage, words on the label, the user's photo once taken) |
| `equipment` | Instruments and consumables, each with an icon id and setting |
| `mixes` | Reagents mixed from parts (for BCA, Working Reagent = 50 parts A : 1 part B), with expected appearance and stability notes |
| `standardCurves` | Dilution series vial by vial: diluent volume, source (stock, an earlier vial, or none for the blank), volume taken, final concentration. Volumes are as printed; `standardSeries()` in `shared/calc.ts` resizes them for each run |
| `procedures` | Each way to run the kit. An assay (`microplate` or `tube`, BCA) has its sample and mix volumes, mix, standard curve, range and steps; a cell protocol (`cells`) has only its steps. `isAssay()` tells them apart; Plan, the plate, Run and Results need an assay |
| `steps` | Stage (standards, prepare, mix, load, treat, incubate, wash, read, observe, analyze), Chapp's title and one-line `key` for the bench, additions per well or tube, timer (with documented alternatives), equipment, notes |
| `analysis` | Readout wavelength, preferred curve fits, notes; absent for a kit with nothing to read |
| `defaults` | The starting conditions: the procedure, and samples and replicates when the source works an example |
| `notes` | Assay-wide notes: intended use, interfering substances, handling |
| `imported` | Set when Chapp read the document from the manual itself: when, with which model, how long it took, and what `problems()` and the import found |

## Read from a manual

`server/ai/import.ts` reads a vendor's PDF into this format with Muse Spark: from the Home + menu's Upload
(`POST /api/import-protocol`), or when a web search finds the manual of a kit Chapp has no protocol for
(`server/imports.ts`, behind `/api/find-protocol`). Strict JSON schemas only hold for flat objects, so the model fills
lists of rows that point at each other by id. Two reads of the same manual run side by side: the intro (what the kit
is, the manual's at-a-glance lines, the main procedure's steps as printed and the kit's contents, streamed to the
Overview as `intro`), and the deep read: the inventory (document, kit, bottles, equipment, mixes, dilution tables,
procedures), then the steps, the tables' vials and the notes at once. The steps think at low and every other call at
minimal (`EFFORTS`); only the intro reads the PDF itself, the others its text (pdftotext, `TEXT_CALLS`). On the BCA
manual (1 November 2026, the median of three runs) the intro took about 9 s and the whole protocol was read 26.5 s after
the search began. The intro's title, summary and overview become the protocol's. The rows are assembled, checked with
zod and `problems()`, and saved as `data/protocols/<id>.json` with the PDF in `data/sources/<id>/manual.pdf`; a
hand-made document is never replaced, and the same file is never read twice.
`scripts/import-protocol.ts` runs one import and compares it with a hand-made document (`server/ai/import-check.ts`).

## Example

The first document, `data/protocols/pierce-bca.json`, is the Thermo Fisher *Pierce BCA Protein Assay Kit User Guide*
(MAN0011430, revision D, 18 June 2026), both procedures and both dilution tables. It stays local with the manual itself;
`npm test` checks its quotes against the manual's pages whenever both are present. `server/demo/pierce-bca.json` is the
same document without the manual's words (each citation names its page instead, `scripts/demo-protocol.ts`): a clean
checkout starts with it.
