// One-time venue setup for the Fuse worker's Velocity account.
//   npm run venue:setup                 status only: wallet, collateral, market, open position
//   npm run venue:setup -- --fund 25    devnet: mint dUSDT if needed, create the account, deposit up to $25
//
// Devnet dUSDT comes from the SDK's TokenFaucet program (VELOCITY_FAUCET_PROGRAM_ID). The default is
// the address in the SDK's bundled token_faucet IDL; confirm it with Velocity if minting fails.
import { createRequire } from 'node:module';
import { VelocityPerpAdapter } from '../src/adapters/perp/velocity-perp.mjs';
import { velocityOptions } from '../src/adapters/perp/factory.mjs';

const require = createRequire(import.meta.url);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const fund = Number(arg('fund') || 0);
const env = process.env;
const faucetId = env.VELOCITY_FAUCET_PROGRAM_ID || require('@velocity-exchange/sdk/lib/node/idl/token_faucet.json').address;

const perp = await new VelocityPerpAdapter(velocityOptions(env)).init();
const status = async () => {
  const pos = await perp.getPosition();
  const wallet = await perp.walletQuote();
  console.table({
    venue: `Velocity ${perp.cluster} ${perp.opts.symbol} @ $${perp.markPrice().toFixed(2)}`,
    wallet: perp.kp.publicKey.toBase58(),
    walletSol: (await perp.connection.getBalance(perp.kp.publicKey)) / 1e9,
    walletCollateral: wallet.amount,
    venueAccount: perp.hasUser ? perp.userPk.toBase58() : '(not created)',
    venueCollateralUsd: await perp.collateralUsd(),
    openPositionUsd: Number(pos.exposureUsd.toFixed(2)),
    orderStepSol: perp.stepBase,
    minOrderSol: perp.minBase
  });
};

await status();
if (fund > 0) {
  if (perp.cluster === 'mainnet-beta') { console.error('--fund only mints on devnet. On mainnet, send USDT to the wallet and re-run.'); process.exit(2); }
  const { amount } = await perp.walletQuote();
  const need = fund - (await perp.collateralUsd()) - amount;
  if (need > 0) {
    const sig = await perp.mintDevnetQuote(Math.ceil(need), faucetId);
    console.log(`minted ${Math.ceil(need)} dUSDT: https://solscan.io/tx/${sig}?cluster=devnet`);
  }
  const r = await perp.ensureCollateral(fund);
  for (const t of perp.setupTxs || []) console.log(`${t.ix.padEnd(26)} https://solscan.io/tx/${t.signature}?cluster=devnet`);
  console.log(`collateral now $${r.collateralUsd.toFixed(2)}`);
  await status();
}
process.exit(0);
