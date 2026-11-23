import { DriverPerpAdapter } from './driver-perp.mjs';
import { VelocityPerpAdapter } from './velocity-perp.mjs';

export function velocityOptions(env = process.env) {
  return {
    env: env.VELOCITY_ENV || env.SOLANA_CLUSTER || 'devnet',
    allowMainnetOrders: env.FUSE_ALLOW_MAINNET_ORDERS === 'I_ACKNOWLEDGE_REAL_FUNDS',
    rpcUrl: env.VELOCITY_RPC_URL || env.SOLANA_RPC_URL,
    privateKeyJson: env.VELOCITY_PRIVATE_KEY_JSON,
    marketIndex: Number(env.VELOCITY_MARKET_INDEX || 0),
    subAccountId: Number(env.VELOCITY_SUBACCOUNT_ID || 0),
    symbol: env.PERP_SYMBOL || 'SOL-PERP',
    minOrderUsd: Number(env.VELOCITY_MIN_ORDER_USD || 1),
    maxSlippageBps: Number(env.VELOCITY_MAX_SLIPPAGE_BPS || env.PERP_MAX_SLIPPAGE_BPS || 50),
    fillTimeoutMs: Number(env.VELOCITY_FILL_TIMEOUT_MS || 20000)
  };
}

export async function makePerpAdapter(env = process.env) {
  const mode = (env.PERP_ADAPTER || 'velocity').toLowerCase();
  if (mode === 'paper') throw new Error('PERP_ADAPTER=paper is not available for the live worker');
  if (mode === 'driver') return new DriverPerpAdapter({ baseUrl: env.PERP_DRIVER_URL, token: env.PERP_DRIVER_TOKEN, symbol: env.PERP_SYMBOL || 'SOL-PERP' });
  if (mode === 'velocity') return new VelocityPerpAdapter(velocityOptions(env)).init();
  if (mode === 'drift' || mode === 'flash') throw new Error(`PERP_ADAPTER=${mode} is retired: Drift was replaced by Velocity and Flash Trade shut down. Use PERP_ADAPTER=velocity`);
  throw new Error(`unsupported PERP_ADAPTER=${mode}`);
}
