// Demonstrates how an external agent can propose a target but cannot make a
// precheck response into a transaction. OFFLINE FIXTURE; NO ONCHAIN EVIDENCE.
import fs from 'node:fs/promises';
import { initialFuse } from '../src/core/state.mjs';
import { policyHash } from '../src/core/policy.mjs';
import { evaluateAgentProposal } from '../src/core/agent-proposal.mjs';
const policy = JSON.parse(await fs.readFile('./policy.example.json', 'utf8'));
const fuse = initialFuse({ id: 'offline-agent-demo', policy, policyHash: policyHash(policy) });
fuse.status = 'ARMED';
const quote = { probability: 0.62, quality: true };
for (const targetUsd of [25, 100]) {
  const proposal = { targetUsd, policyHash: fuse.policyHash, fuseId: fuse.id, proposedAtMs: Date.now() };
  console.log(JSON.stringify(evaluateAgentProposal({ fuse, quote, proposal }), null, 2));
}
console.log('OFFLINE POLICY DEMO ONLY — no Solana tx, no Velocity fill, no AI model inference.');
