import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

export const EvidenceIdSchema = z
  .string()
  .regex(/^ev-[a-z0-9][a-z0-9-]*$/, 'Evidence IDs must match "ev-<lowercase alphanumeric id>"');
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

const LineNumberSchema = z.number().int().positive();

export const EvidenceLocationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('file'),
      path: z.string().min(1),
      startLine: LineNumberSchema.optional(),
      endLine: LineNumberSchema.optional(),
    })
    .refine(
      (location) =>
        location.startLine === undefined ||
        location.endLine === undefined ||
        location.endLine >= location.startLine,
      { message: 'endLine must be greater than or equal to startLine', path: ['endLine'] },
    ),
  z.object({
    type: z.literal('command'),
    command: z.string().min(1),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('signal'),
    signalId: IdSchema,
  }),
  z.object({
    type: z.literal('url'),
    url: z.url(),
  }),
]);
export type EvidenceLocation = z.infer<typeof EvidenceLocationSchema>;

export const EvidenceKindSchema = z.enum([
  'source_code',
  'test_output',
  'command_output',
  'log',
  'stack_frame',
  'search_result',
  'signal_excerpt',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSourceSchema = z.object({
  /** Name of the tool that produced the evidence. */
  tool: z.string().min(1),
  actionId: IdSchema.optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  id: EvidenceIdSchema,
  kind: EvidenceKindSchema,
  summary: z.string().min(1),
  content: z.string().optional(),
  location: EvidenceLocationSchema,
  source: EvidenceSourceSchema,
  collectedAt: TimestampSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export interface EvidenceIdInput {
  readonly tool: string;
  readonly location: EvidenceLocation;
  readonly content?: string;
}

/**
 * Derives a content-addressed evidence ID so the same observation always maps
 * to the same ID across runs, replays, and processes.
 */
export function createEvidenceId(input: EvidenceIdInput): EvidenceId {
  const digest = createHash('sha256')
    .update(stableStringify({ tool: input.tool, location: input.location, content: input.content ?? '' }))
    .digest('hex');
  return `ev-${digest.slice(0, 16)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
