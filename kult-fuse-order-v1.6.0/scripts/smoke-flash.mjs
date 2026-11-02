import { FlashPerpAdapter } from '../src/adapters/perp/flash-perp.mjs';

const cluster = process.env.FLASH_CLUSTER || 'devnet';
if (cluster !== 'devnet' && process.env.CONFIRM_FLASH_MAINNET !== 'YES') {
  throw new Error('Refusing Flash mainnet smoke. Set CONFIRM_FLASH_MAINNET=YES only after review.');
}
const adapter = new FlashPerpAdapter({
  rpcUrl: process.env.SOLANA_RPC_URL,
  commitment: process.env.SOLANA_COMMITMENT || 'confirmed',
  privateKeyJson: process.env.FLASH_PRIVATE_KEY_JSON,
  cluster,
  poolName: process.env.FLASH_POOL || (cluster === 'devnet' ? 'devnet.1' : 'Crypto.1'),
  targetSymbol: process.env.FLASH_TARGET_SYMBOL || 'SOL',
  collateralSymbol: process.env.FLASH_COLLATERAL_SYMBOL || 'USDC',
  leverageX: Number(process.env.FLASH_LEVERAGE_X || 1),
  maxSlippageBps: Number(process.env.PERP_MAX_SLIPPAGE_BPS || 50),
  minOrderUsd: Number(process.env.FLASH_MIN_ORDER_USD || 5)
});
await adapter.init();
console.log('Flash position before:', await adapter.getPosition());

const target1 = Number(process.env.FLASH_SMOKE_OPEN_USD || 0);
const target2 = Number(process.env.FLASH_SMOKE_RESIZE_USD || 0);
if (!target1) {
  console.log('READ-ONLY PASS. To execute devnet lifecycle set FLASH_SMOKE_OPEN_USD=20 CONFIRM_FLASH_SMOKE=YES.');
  process.exit(0);
}
if (process.env.CONFIRM_FLASH_SMOKE !== 'YES') throw new Error('Set CONFIRM_FLASH_SMOKE=YES to submit Flash smoke trades.');

const open = await adapter.executeTarget(target1, { clientOrderId: `smoke-open-${Date.now()}` });
console.log('OPEN:', open);
if (target2 > 0 && target2 !== target1) {
  const resize = await adapter.executeTarget(target2, { clientOrderId: `smoke-resize-${Date.now()}` });
  console.log('RESIZE:', resize);
}
const close = await adapter.executeTarget(0, { clientOrderId: `smoke-close-${Date.now()}`, reduceOnly: true });
console.log('CLOSE:', close);
const final = await adapter.getPosition();
console.log('FINAL:', final);
if (Math.abs(Number(final.exposureUsd || 0)) > Number(process.env.FLASH_MIN_ORDER_USD || 5)) throw new Error('Flash smoke ended with residual exposure');
console.log('FLASH LIFECYCLE PASS');
