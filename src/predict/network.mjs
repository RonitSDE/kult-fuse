export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export async function assertDevnet(connection) {
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) {
    throw new Error('RPC is not Solana Devnet. Signing and verification disabled.');
  }
}
