// A PREDICT swap with a signed KULT Fuse memo in the same transaction.
//
// Same instructions as @pm-amm/sdk `send.swap` (compute budget, idempotent ATAs for the swapper's
// YES/NO/collateral accounts and the DAO + creator fee accounts, then `ix.swap`), plus one SPL Memo
// signed by the swapper. The public path supplies a server-issued trade attestation.
export const APP_MEMO = 'kult-fuse:predict:v2';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * @param deps   { web3, splToken, sdk } module namespaces (injected so Node tests and the browser share this)
 * @param client PmAmmClient bound to the signer's wallet
 * @param market { marketPda, authority, collateralMint } from the fetched market account
 */
export async function buildTaggedSwapIxs(deps, client, { marketPda, authority, collateralMint }, direction, amountRaw, minOutRaw, memoText = APP_MEMO) {
  const { web3, splToken, sdk } = deps;
  const { PublicKey, TransactionInstruction, ComputeBudgetProgram } = web3;
  const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = splToken;
  if (!['usdcToYes', 'usdcToNo'].includes(direction)) throw new Error('Only USDC → YES/NO buys are tagged');
  if (!Number.isSafeInteger(amountRaw) || amountRaw <= 0 || !Number.isSafeInteger(minOutRaw) || minOutRaw < 1) throw new Error('Invalid raw swap amounts');
  const signer = client.walletPubkey();
  const market = new PublicKey(marketPda);
  const creator = new PublicKey(authority);
  const collateral = new PublicKey(collateralMint);
  const ata = (mint, owner, offCurve = false) => getAssociatedTokenAddressSync(mint, owner, offCurve);
  const create = (mint, owner, offCurve = false) => createAssociatedTokenAccountIdempotentInstruction(signer, ata(mint, owner, offCurve), owner, mint);
  const pre = [create(client.yesMint(market), signer), create(client.noMint(market), signer), create(collateral, signer), create(collateral, sdk.PROTOCOL_DAO, true)];
  if (!creator.equals(signer)) pre.push(create(collateral, creator, true));
  const swap = await client.ix.swap({ signer, market, direction, amountIn: amountRaw, minOutput: minOutRaw, creatorAuthority: creator, collateralMint: collateral });
  const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: new TextEncoder().encode(memoText) });
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: sdk.CU.HEAVY }), ...pre, swap, memo];
}
