export const INTENTS = ['START_INVESTIGATION', 'GET_RESULT', 'HELP'] as const;
export type Intent = (typeof INTENTS)[number];

/** Longer utterances are not interpreted. */
export const MAX_UTTERANCE_LENGTH = 500;

export interface ClassifiedUtterance {
  readonly intent: Intent;
  /** As received. */
  readonly utterance: string;
  /** Lowercase letters, digits, and single spaces; see `normalizeUtterance`. */
  readonly normalized: string;
}

const RESULT_PATTERNS: readonly RegExp[] = [
  /\bwhat did (you|it|devpilot) find\b/,
  /\bwhat(s| is| was) the (result|results|status|outcome)\b/,
  /\b(give|tell) me the (result|results|status|outcome)\b/,
  /\bis it (fixed|done|finished|ready)\b/,
];

const START_PATTERNS: readonly RegExp[] = [
  /\binvestigate\b/,
  /\bstart (an |a |the )?investigation\b/,
  /\bcheck (the |my )?(failing|broken) tests?\b/,
  /\bfind out whats wrong\b/,
];

/**
 * Words that turn a start phrase after them into a refusal ("don't
 * investigate", "no, investigate") or a question about whether to start one
 * ("should I investigate"). Starting an investigation has side effects, so
 * any of these before the last start phrase makes the utterance HELP; after
 * it, as in "investigate why the tests do not pass", they do not.
 */
const START_BLOCKERS: readonly RegExp[] = [
  /^(no|nope|nah|not)\b/,
  /\b(dont|do not|never|no need to|stop|cancel|abort|hold off)\b/,
  /\b(should|shall) (i|we|you|it|devpilot)\b/,
  /\b(do|does) (i|we|you|it|devpilot) (need|have|want) to\b/,
  /\bwhether\b/,
  /\bis it worth\b/,
];

/**
 * A negation directly before a start phrase ("you should not investigate",
 * "let's not investigate") or directly after it ("investigate nothing")
 * negates the request itself, wherever that start phrase is.
 */
const NEGATED_REQUEST = /\b(not|cannot|dont|doesnt|didnt|shouldnt|mustnt|wouldnt|couldnt|wont|cant|neednt|shant)( (to|ever|even|yet|really|actually))?$/;
const NEGATED_OBJECT = /^(nothing|none|no)\b/;

/**
 * Lowercases, drops apostrophes ("what's" becomes "whats"), turns every
 * other non-alphanumeric character into a space, and collapses whitespace.
 */
export function normalizeUtterance(utterance: string): string {
  return utterance
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Maps an utterance to an intent with fixed phrase patterns. Only the request
 * is recognised; nothing in the utterance is treated as a fact about the
 * repository. Reading a result is checked before starting an investigation,
 * so an utterance that matches both does not start one, and a negated or
 * questioning start is HELP (see `START_BLOCKERS` and `NEGATED_REQUEST`).
 */
export function classifyIntent(utterance: string): ClassifiedUtterance {
  if (typeof utterance !== 'string' || utterance.length > MAX_UTTERANCE_LENGTH) {
    return { intent: 'HELP', utterance: typeof utterance === 'string' ? utterance : '', normalized: '' };
  }
  const normalized = normalizeUtterance(utterance);
  const intent: Intent = RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
    ? 'GET_RESULT'
    : requestsStart(normalized)
      ? 'START_INVESTIGATION'
      : 'HELP';
  return { intent, utterance, normalized };
}

function requestsStart(normalized: string): boolean {
  const starts = START_PATTERNS.flatMap((pattern) => [...normalized.matchAll(new RegExp(pattern.source, 'g'))]);
  if (starts.length === 0) return false;
  const beforeLastStart = normalized.slice(0, Math.max(...starts.map((match) => match.index)));
  if (START_BLOCKERS.some((blocker) => blocker.test(beforeLastStart))) return false;
  return !starts.some(
    (match) =>
      NEGATED_REQUEST.test(normalized.slice(0, match.index).trimEnd()) ||
      NEGATED_OBJECT.test(normalized.slice(match.index + match[0].length).trimStart()),
  );
}
