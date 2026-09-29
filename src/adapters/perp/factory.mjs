import { DriverPerpAdapter } from './driver-perp.mjs';
import { FlashPerpAdapter } from './flash-perp.mjs';

export async function makePerpAdapter(env = process.env) {
  const mode = (env.PERP_ADAPTER || 'flash').toLowerCase();
  if (mode === 'driver') return new DriverPerpAdapter({ baseUrl: env.PERP_DRIVER_URL, token: env.PERP_DRIVER_TOKEN, symbol: env.PERP_SYMBOL || 'SOL-PERP' });
  if (mode === 'flash') {
    const adapter = new FlashPerpAdapter({
      rpcUrl: env.SOLANA_RPC_URL,
      commitment: env.SOLANA_COMMITMENT || 'confirmed',
      privateKeyJson: env.FLASH_PRIVATE_KEY_JSON,
      cluster: env.FLASH_CLUSTER || 'devnet',
      poolName: env.FLASH_POOL || ((env.FLASH_CLUSTER || 'devnet') === 'devnet' ? 'devnet.1' : 'Crypto.1'),
      targetSymbol: env.FLASH_TARGET_SYMBOL || 'SOL',
      collateralSymbol: env.FLASH_COLLATERAL_SYMBOL || 'USDC',
      symbol: env.PERP_SYMBOL || 'SOL-PERP',
      leverageX: Number(env.FLASH_LEVERAGE_X || 1),
      maxSlippageBps: Number(env.PERP_MAX_SLIPPAGE_BPS || 50),
      prioritizationFee: Number(env.FLASH_PRIORITIZATION_FEE || 0),
      minOrderUsd: Number(env.FLASH_MIN_ORDER_USD || 5),
      fillTimeoutMs: Number(env.FLASH_FILL_TIMEOUT_MS || 15000)
    });
    await adapter.init();
    return adapter;
  }
  throw new Error(`unsupported PERP_ADAPTER=${mode}`);
}
