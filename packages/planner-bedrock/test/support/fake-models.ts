import { fileURLToPath } from 'node:url';
import type { EscalationRequest, ModelClient } from '../../src/index.js';

/** The repository the rule planner cannot explain; tests answer for the model with `shippingModel`. */
export const SHIPPING_ROOT = fileURLToPath(new URL('../../../../fixtures/shipping-repository/', import.meta.url));
export const SHIPPING_BUGGY_LINE = '  const shipping = subtotal > freeThreshold ? 0 : flatRate;';
export const SHIPPING_FIXED_LINE = '  const shipping = subtotal >= freeThreshold ? 0 : flatRate;';
export const SHIPPING_STATEMENT =
  'The free-shipping check uses > where the documented rule is "at or above", so an order exactly at the threshold pays shipping.';

export const SHIPPING_SIGNAL = {
  kind: 'failing_test',
  title: 'Orders exactly at the free-shipping threshold are charged shipping',
  content: 'not ok 3 - ships free exactly at the threshold\n    500 !== 0',
} as const;

export interface LineEdit {
  readonly path: string;
  readonly originalText: string;
  readonly replacementText: string;
}

export const SHIPPING_EDIT: LineEdit = { path: 'src/shipping.ts', originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE };

/**
 * Stands in for a model on the shipping incident. Evidence IDs are content
 * addressed and vary between runs, so it reads them from the request, as a
 * model would, and answers with the given edit.
 */
export function shippingModel(edit: LineEdit = SHIPPING_EDIT) {
  const requests: EscalationRequest[] = [];
  const client: ModelClient = {
    name: 'fake-shipping-model',
    assess: async (request) => {
      requests.push(request);
      const idOf = (kind: string, file?: string) =>
        request.evidence.find((item) => item.kind === kind && (file === undefined || (item.location.type === 'file' && item.location.path === file)))?.id;
      const source = idOf('source_code', 'src/shipping.ts');
      const test = idOf('source_code', 'test/shipping.test.ts');
      const run = idOf('command_output');
      const edited = request.evidence.find((item) => item.id === (edit.path === 'src/shipping.ts' ? source : test));
      const line = (edited?.content ?? '').split('\n').indexOf(edit.originalText) + 1;
      return {
        hypotheses: [
          { key: 'threshold-comparison', statement: SHIPPING_STATEMENT, supportingEvidenceIds: [source, test, run], contradictingEvidenceIds: [] },
          { key: 'flat-rate', statement: 'The caller passes the wrong flat rate.', supportingEvidenceIds: [], contradictingEvidenceIds: [test] },
        ],
        edit: { hypothesisKey: 'threshold-comparison', line, ...edit },
      };
    },
  };
  return { client, requests };
}

/** A model that must never be asked: it counts calls and fails them. */
export function countingModel() {
  const counter = { calls: 0 };
  const client: ModelClient = {
    name: 'counting-model',
    assess: async () => {
      counter.calls += 1;
      throw new Error('must not be called');
    },
  };
  return { client, counter };
}
