/**
 * Manual live check, never run by `npm test`: one escalation of the shipping
 * fixture through Amazon Bedrock, verified by the repair workflow in a
 * temporary Git repository. It makes at most one model request and prints
 * only summary fields, never the prompt or the reply.
 *
 *   DEVPILOT_LIVE_BEDROCK=1 AWS_PROFILE=devpilot node --import tsx packages/planner-bedrock/test/live/bedrock.live.ts
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Signal } from '@devpilot/core';
import { GroundedRepairPipeline, type GroundedRepairRun } from '@devpilot/engine';
import { resolveGitExecutable } from '@devpilot/tools';
import { createGitRepositoryFixture } from '../../../tools/test/support/git-repository.js';
import { EscalatingPlanner, type EscalationEvent } from '../../src/index.js';
import { createBedrockModelClient, LIVE_BEDROCK_FLAG, NOVA_PRO_MODEL_ID, type BedrockRuntimeConfig } from '../../src/bedrock.js';
import { SHIPPING_ROOT, SHIPPING_SIGNAL } from '../support/fake-models.js';

// Public AWS Price List, offer AmazonBedrock 20261006144726, ap-southeast-2, on-demand Nova Pro.
const USD_PER_1K_INPUT = 0.00084;
const USD_PER_1K_OUTPUT = 0.00336;

let config: BedrockRuntimeConfig | undefined;
let sends = 0;
let usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
const model = createBedrockModelClient(process.env, {
  createRuntime: (runtimeConfig) => {
    config = runtimeConfig;
    const client = new BedrockRuntimeClient(runtimeConfig);
    return {
      send: async (command, options) => {
        sends += 1;
        const output = await client.send(command, options);
        usage = output.usage;
        return output;
      },
    };
  },
});

if (!model) {
  console.error(`Refusing to call Bedrock: set ${LIVE_BEDROCK_FLAG}=1 to opt in.`);
  process.exitCode = 1;
} else {
  const git = await resolveGitExecutable();
  const fixture = await createGitRepositoryFixture(git, SHIPPING_ROOT);
  const events: EscalationEvent[] = [];
  const signal: Signal = { ...SHIPPING_SIGNAL, id: 'sig-live-shipping', command: 'npm test', receivedAt: new Date().toISOString() };
  let run: GroundedRepairRun | undefined;
  try {
    const planner = new EscalatingPlanner({ model, maxModelCalls: 1, onEvent: (event) => events.push(event) });
    run = await new GroundedRepairPipeline({ allowedRoot: fixture.allowedRoot, git, planner }).run({ repositoryRoot: fixture.root, signal });
  } finally {
    await run?.repair?.workspace?.remove();
    await fixture.cleanup();
  }
  console.log(`model: ${NOVA_PRO_MODEL_ID}`);
  console.log(`region: ${config?.region}`);
  console.log(`modelRequests: ${sends}`);
  console.log(`escalation: ${events.map((event) => (event.type === 'escalated' ? 'escalated' : `fallback (${event.reason})`)).join(', ') || 'none'}`);
  console.log(`proposal: ${run?.proposal?.status ?? 'none passed review'}`);
  console.log(`repair: ${run?.repair?.result.status ?? 'not attempted'}`);
  console.log(`groundingValid: ${run?.grounding.valid}`);
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  console.log(`tokens: input ${input ?? 'not returned'}, output ${output ?? 'not returned'}`);
  if (input !== undefined && output !== undefined) {
    const usd = (input / 1000) * USD_PER_1K_INPUT + (output / 1000) * USD_PER_1K_OUTPUT;
    console.log(`estimatedCostUSD: ${usd.toFixed(6)} (estimate from the public AWS Price List; not a billed amount)`);
  }
}
