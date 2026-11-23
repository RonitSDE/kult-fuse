// What a deployment still needs before the live worker can run. Pure: env in, checklist out.
// The server shows this instead of a dead page when the live runtime cannot start.
import fs from 'node:fs';

const keyOk = (json) => { try { const a = JSON.parse(json || ''); return Array.isArray(a) && a.length >= 32; } catch { return false; } };

export function setupChecklist(env = process.env) {
  const items = [];
  const add = (group, id, label, ok, hint) => items.push({ group, id, label, ok: Boolean(ok), hint: ok ? null : hint });
  const source = (env.EVENT_SOURCE || 'dflow').toLowerCase();
  if (source === 'dflow') add('Signal', 'market', 'Kalshi market selected on DFlow', env.DFLOW_MARKET_MINT, 'Run `npm run markets` and set DFLOW_MARKET_MINT to a YES mint.');
  else if (source === 'polymarket') add('Signal', 'market', 'Polymarket market selected', env.POLYMARKET_MARKET, 'Set POLYMARKET_MARKET to a market slug.');
  else add('Signal', 'market', 'Supported event source', false, `EVENT_SOURCE=${source} is not supported; use dflow.`);

  const venue = (env.PERP_ADAPTER || 'velocity').toLowerCase();
  const venueEnv = env.VELOCITY_ENV || env.SOLANA_CLUSTER || 'devnet';
  if (venue === 'velocity') {
    add('Venue', 'venueKey', 'Velocity trading key', keyOk(env.VELOCITY_PRIVATE_KEY_JSON), 'Set VELOCITY_PRIVATE_KEY_JSON (a dedicated wallet), then `npm run venue:setup -- --fund 25`.');
    add('Venue', 'venueCluster', 'Venue and Fuse on one cluster', (env.SOLANA_CLUSTER || 'devnet') === venueEnv, `Fuse is on ${env.SOLANA_CLUSTER || 'devnet'}, Velocity on ${venueEnv}.`);
  } else if (venue === 'driver') add('Venue', 'venueKey', 'Venue driver URL', env.PERP_DRIVER_URL, 'Set PERP_DRIVER_URL.');
  else add('Venue', 'venueKey', 'Supported venue', false, `PERP_ADAPTER=${venue} is retired; use velocity.`);

  const idl = env.FUSE_IDL_PATH || './deploy/idl/kult_fuse.json';
  add('Fuse program', 'program', 'Fuse program deployed', env.FUSE_PROGRAM_ID, '`anchor deploy` the program and set FUSE_PROGRAM_ID.');
  add('Fuse program', 'idl', 'Program IDL in the build', fs.existsSync(idl), `Copy target/idl/kult_fuse.json to ${idl}.`);
  add('Fuse program', 'keys', 'Owner, oracle and execution keys', ['FUSE_OWNER_PRIVATE_KEY_JSON', 'FUSE_ORACLE_PRIVATE_KEY_JSON', 'FUSE_EXECUTION_PRIVATE_KEY_JSON'].every((k) => keyOk(env[k])), 'Set three distinct keypairs (JSON arrays).');

  const token = env.FUSE_ADMIN_TOKEN || '';
  add('Operator', 'token', 'Operator token', token.length >= 24 && !token.startsWith('CHANGE_ME'), 'Set FUSE_ADMIN_TOKEN to 24+ random characters.');
  return items;
}
