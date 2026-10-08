import type { DialogState } from '../../../voice-demo/src/dialog.js';
import { MAX_UTTERANCE_LENGTH } from '../../../voice-demo/src/intents.js';

export const MAX_BODY_BYTES = 4 * 1024;

/** The MCP server's repository ID format. */
const REPOSITORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Job IDs are opaque to the simulator; the MCP server decides whether one exists. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATE_KEYS: readonly string[] = ['repositoryId', 'jobId', 'investigationStarted'];

export interface DialogRequest {
  readonly utterance: string;
  readonly state: DialogState;
}

/** `{ utterance, state }` and nothing else; undefined when anything does not match. */
export function parseDialogRequest(value: unknown): DialogRequest | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['utterance', 'state'])) return undefined;
  const { utterance } = value;
  if (typeof utterance !== 'string' || utterance.trim() === '' || utterance.length > MAX_UTTERANCE_LENGTH) return undefined;
  const state = parseDialogState(value.state);
  return state ? { utterance, state } : undefined;
}

/** A conversation state as the browser holds it: optional IDs in their bounded formats, and a flag. */
export function parseDialogState(value: unknown): DialogState | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, STATE_KEYS)) return undefined;
  const { repositoryId, jobId, investigationStarted } = value;
  if (typeof investigationStarted !== 'boolean') return undefined;
  if (repositoryId !== undefined && !(typeof repositoryId === 'string' && REPOSITORY_ID.test(repositoryId))) return undefined;
  if (jobId !== undefined && !(typeof jobId === 'string' && JOB_ID.test(jobId))) return undefined;
  return { repositoryId, jobId, investigationStarted };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
