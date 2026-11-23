import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDefaultPredictRegistry } from '../src/predict/registry.mjs';

const requirePredict = createRequire(new URL('../apps/predict/package.json', import.meta.url));
let failed = false;
async function check(label, action) {
  try {
    await action();
    console.log('PASS ' + label);
  } catch (error) {
    failed = true;
    console.error('FAIL ' + label + ' — ' + error.message);
  }
}

await check('Node 24 or newer', () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(process.version);
});
await check('Official PREDICT SDK and quote helpers', () => {
  if (typeof requirePredict('@pm-amm/sdk').PmAmmClient !== 'function' ||
      typeof requirePredict('@pm-amm/sdk/math').estimateSwapOutput !== 'function') throw new Error('Run npm run predict:install');
});
await check('Built public frontend', async () => {
  const html = await fs.readFile('apps/predict/dist/index.html', 'utf8');
  if (!html.includes('Market lifecycle')) throw new Error('Run npm run predict:build');
});
await check('Writable receipt directory', async () => {
  const file = process.env.PREDICT_RECEIPTS_FILE || path.join(process.env.DATA_DIR || '.data', 'predict-receipts.json');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const probe = await fs.mkdtemp(path.join(dir, '.predict-write-'));
  await fs.rmdir(probe);
});
await check('Attribution key configured', () => {
  if (!/^[a-f0-9]{64}$/i.test(process.env.PREDICT_ATTESTATION_KEY ?? '')) {
    throw new Error('Set PREDICT_ATTESTATION_KEY to openssl rand -hex 32 output');
  }
});
await check('Devnet RPC identity, PREDICT program and receipt read', async () => {
  if (!/^[a-f0-9]{64}$/i.test(process.env.PREDICT_ATTESTATION_KEY ?? '')) throw new Error('Requires attribution key');
  try { await (await createDefaultPredictRegistry()).ready(); }
  catch { throw new Error('Check the configured HTTPS Devnet RPC, executable program and persistent receipt file'); }
});
if (failed) process.exitCode = 1;
