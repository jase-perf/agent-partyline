export interface TranscriptEntryLike {
  type: string
  tool_name?: string
  [key: string]: unknown
}

export type GroupedItem =
  | { kind: 'entry'; entry: TranscriptEntryLike }
  | { kind: 'tool-group'; entries: TranscriptEntryLike[] }

export const TOOL_GROUP_MIN_RUN: number

export function groupSequentialToolCalls(entries: TranscriptEntryLike[]): GroupedItem[]

export function summarizeToolGroup(entries: TranscriptEntryLike[], maxNames?: number): string

export function shouldExtendToolRun(
  tailEntry: TranscriptEntryLike | null | undefined,
  newEntry: TranscriptEntryLike,
): boolean
