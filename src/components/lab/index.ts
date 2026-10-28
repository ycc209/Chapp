// The bench parts (Plan, Run, Results). Presentational: data comes in as props, worked out by model.ts and
// shared/fit.ts from the protocol and the plan. See them all at /lab.
export * from './model.ts';
export { Check, BenchLine, DotLabel, Mark, SampleDataTag, SectionHead } from './Text.tsx';
export { VialCard, VialDot, VialNow, VialRack, currentVial, type VialCardProps, type VialDotProps, type VialRackProps, type VialState } from './Vials.tsx';
export { StandardsTable, type StandardsTableProps } from './StandardsTable.tsx';
export { PlateMap, type PlateMapProps } from './PlateMap.tsx';
export { ReagentParts, type ReagentPartsProps } from './Reagent.tsx';
export { NumberedList, StepList, type StepItem } from './Lists.tsx';
export { DoneAt, Timer, useNow, type TimerProps } from './Timer.tsx';
export { MarkChips, type MarkChipsProps } from './MarkChips.tsx';
export { StandardCurve, fitCaption, type StandardCurveProps } from './StandardCurve.tsx';
export { ResultRows, type ResultRowsProps } from './Results.tsx';
export { AmountCard, StepPill, TimerNotice, type AmountCardProps, type StepPillProps } from './Cards.tsx';
