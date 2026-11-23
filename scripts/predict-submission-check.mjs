import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Connection, PublicKey } from '@solana/web3.js';
import { assertDevnet } from '../src/predict/network.mjs';
import { anchorIx, decodeBase58 } from '../src/predict/proof.mjs';
import { isBase58 } from '../src/predict/attestation.mjs';
import { DEVNET_MUSDC, PROGRAM_ID, RPC_DEFAULT } from '../src/predict/policy.mjs';

const requirePredict = createRequire(new URL('../apps/predict/package.json', import.meta.url));
const program = new PublicKey(PROGRAM_ID);
const mint = new PublicKey(DEVNET_MUSDC);
const fail = message => { throw new Error(message); };
const explorer = signature => `https://solscan.io/tx/${signature}?cluster=devnet`;

function httpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a public HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`${label} must be a public HTTPS URL`);
  return url;
}
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}
function ixFrom(tx, name, accounts) {
  const instructions = tx.transaction.message.instructions.filter(instruction => {
    try {
      return String(instruction.programId) === PROGRAM_ID &&
        decodeBase58(instruction.data).subarray(0, 8).equals(anchorIx(name)) &&
        accounts.every(([index, address]) => String(instruction.accounts[index]) === address);
    } catch { return false; }
  });
  if (instructions.length !== 1) fail(`Expected one matching ${name} PREDICT instruction`);
  const ix = instructions[0];
  const signer = String(ix.accounts[0]);
  if (!tx.transaction.message.accountKeys.some(key => String(key.pubkey) === signer && key.signer)) {
    fail(`${name} lacks the expected wallet signer`);
  }
  return { signer, data: decodeBase58(ix.data) };
}
function tokenDelta(tx, wallet, tokenMint) {
  const sum = balances => balances.filter(row => row.owner === wallet && row.mint === tokenMint)
    .reduce((amount, row) => amount + BigInt(row.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances ?? []) - sum(tx.meta.preTokenBalances ?? []);
}

async function main() {
  const origin = httpsUrl(process.env.PUBLIC_URL, 'PUBLIC_URL');
  const video = httpsUrl(process.env.PREDICT_VIDEO_URL, 'PREDICT_VIDEO_URL');
  const sha = process.env.BUILD_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) fail('Set BUILD_SHA to the deployed Git commit');
  const file = process.env.PREDICT_LIFECYCLE_INPUT;
  if (!file) fail('Set PREDICT_LIFECYCLE_INPUT to the signed lifecycle evidence JSON');
  const input = JSON.parse(await readFile(file, 'utf8'));
  const { vaultPda, marketPda, createVault, commitments, launch, swaps, resolution, claim } = input;
  if (![vaultPda, marketPda].every(key => isBase58(key, 32))) fail('Valid vault and market addresses are required');
  if (!Array.isArray(commitments) || commitments.length < 2 || commitments.length > 20 ||
      !Array.isArray(swaps) || swaps.length < 3 || swaps.length > 30) {
    fail('Supply selected signatures for at least two commitments and three swaps');
  }
  const signatures = [createVault, ...commitments, launch, ...swaps, resolution, claim];
  if (signatures.some(value => !isBase58(value, 64)) || new Set(signatures).size !== signatures.length) {
    fail('Every lifecycle step requires a distinct Solana transaction signature');
  }

  const [config, stats] = await Promise.all([
    getJson(new URL('/api/predict/config', origin)), getJson(new URL('/api/predict/stats', origin))
  ]);
  if (config.buildSha !== sha || config.network !== 'devnet' || config.programId !== PROGRAM_ID ||
      config.collateralMint !== DEVNET_MUSDC || config.scoringCommitment !== 'finalized' ||
      config.attribution !== 'FUSE_API_ATTESTED') fail('Deployed build or proof configuration mismatch');
  const [home, videoResult] = await Promise.all([
    fetch(origin, { signal: AbortSignal.timeout(10000) }),
    fetch(video, { signal: AbortSignal.timeout(10000) })
  ]);
  const homeHtml = (await home.text()).slice(0, 200_000);
  await videoResult.body?.cancel();
  if (!home.ok || !homeHtml.includes('Market lifecycle') || !homeHtml.includes('KULT')) fail('Public Fuse homepage unavailable');
  if (!videoResult.ok) fail('Demo video URL is unavailable');

  const rpc = httpsUrl(process.env.PREDICT_DEVNET_RPC || RPC_DEFAULT, 'PREDICT_DEVNET_RPC');
  const connection = new Connection(rpc.href, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(9000) })
  });
  await assertDevnet(connection);
  const { PmAmmClient } = requirePredict('@pm-amm/sdk');
  const client = PmAmmClient.readOnly(connection, program, mint);
  const [vault, market] = await Promise.all([
    client.fetchVault(new PublicKey(vaultPda)), client.fetchMarket(new PublicKey(marketPda))
  ]);
  if (!vault?.launched || vault.market.toBase58() !== marketPda || vault.collateralMint.toBase58() !== DEVNET_MUSDC ||
      !market?.resolved || market.collateralMint.toBase58() !== DEVNET_MUSDC) fail('Vault must link to a resolved PREDICT mUSDC market');

  const receipts = [];
  async function transaction(signature, label) {
    const tx = await connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (tx?.meta?.err !== null || tx.transaction.signatures[0] !== signature || !Number.isSafeInteger(tx.blockTime)) {
      fail(`${label} is missing, failed or not finalized`);
    }
    receipts.push({ label, signature, slot: tx.slot, blockTime: tx.blockTime, explorer: explorer(signature) });
    return tx;
  }
  const opened = await transaction(createVault, 'Vault created');
  const { signer: creator } = ixFrom(opened, 'initialize_vault', [[1, vaultPda], [2, DEVNET_MUSDC]]);
  if (creator !== vault.authority.toBase58()) fail('Vault creator does not match the onchain authority');

  const fundedBy = new Set();
  const fundingSides = new Set();
  let fundedRaw = 0n;
  let latestFundingSlot = opened.slot;
  for (const signature of commitments) {
    const tx = await transaction(signature, 'Liquidity commitment');
    const { signer, data } = ixFrom(tx, 'vault_commit', [[1, vaultPda], [2, DEVNET_MUSDC]]);
    if (tx.slot < opened.slot || data.length !== 17 || data[8] > 1) fail('Commitment order or parameters do not match');
    const amount = data.readBigUInt64LE(9);
    if (amount < 1_000_000n || tokenDelta(tx, signer, DEVNET_MUSDC) !== -amount) fail('Commitment lacks the expected mUSDC debit');
    fundedBy.add(signer);
    fundingSides.add(data[8]);
    fundedRaw += amount;
    latestFundingSlot = Math.max(latestFundingSlot, tx.slot);
  }
  if (fundedBy.size < 2 || fundingSides.size !== 2) fail('Provide two distinct committing wallets and both funding sides');
  const launched = await transaction(launch, 'Market launched');
  ixFrom(launched, 'launch_vault_market', [[1, vaultPda], [2, marketPda], [3, DEVNET_MUSDC]]);
  if (launched.slot < latestFundingSlot) fail('Market launch preceded the supplied commitments');

  const tradedBy = new Set();
  const sides = new Set();
  let latestTradeSlot = launched.slot;
  let tradedMUsdc = 0;
  for (const signature of swaps) {
    const tx = await transaction(signature, 'Finalized Fuse swap');
    const { signer: wallet, data } = ixFrom(tx, 'swap', [[1, marketPda], [2, DEVNET_MUSDC],
      [3, market.yesMint.toBase58()], [4, market.noMint.toBase58()]]);
    if (tx.slot < launched.slot || data.length !== 25 || data[8] > 1) fail('Swap order or parameters do not match');
    const side = data[8] === 0 ? 'yes' : 'no';
    const amount = data.readBigUInt64LE(9);
    const outcomeMint = (side === 'yes' ? market.yesMint : market.noMint).toBase58();
    if (tokenDelta(tx, wallet, DEVNET_MUSDC) !== -amount ||
        tokenDelta(tx, wallet, outcomeMint) < data.readBigUInt64LE(17)) fail('Swap token movements did not match');
    const receipt = await getJson(new URL(`/api/predict/receipts/${signature}`, origin));
    if (receipt.signature !== signature || receipt.marketPda !== marketPda || receipt.side !== side ||
        receipt.wallet !== wallet || receipt.outcomeMint !== outcomeMint || receipt.mUsdcSpentRaw !== amount.toString() ||
        receipt.slot !== tx.slot || receipt.evidence !== 'FINALIZED_ONCHAIN_SWAP' ||
        receipt.attribution !== 'FUSE_API_ATTESTED') fail('Public scoreboard receipt did not match the finalized transaction');
    tradedBy.add(wallet);
    sides.add(side);
    tradedMUsdc += Number(amount) / 1e6;
    latestTradeSlot = Math.max(latestTradeSlot, tx.slot);
  }
  if (tradedBy.size < 2 || sides.size !== 2 || stats.finalizedSwaps < swaps.length ||
      stats.uniqueTradingWallets < tradedBy.size || !Number.isFinite(stats.mUsdcVolume) ||
      stats.mUsdcVolume + 0.000001 < tradedMUsdc) fail('Scoreboard must show both sides, two distinct trading wallets and the selected finalized swaps');

  const resolved = await transaction(resolution, 'Market resolved');
  const resolvedIx = ixFrom(resolved, 'resolve_market', [[0, market.authority.toBase58()], [1, marketPda]]);
  const winning = resolvedIx.data[8];
  if (resolved.slot < latestTradeSlot || resolvedIx.data.length !== 9 || ![0, 1].includes(winning) ||
      Number(market.winningSide) !== winning + 1) fail('Resolution timing or winning outcome did not match');
  const source = httpsUrl(input.resolutionEvidenceUrl, 'resolutionEvidenceUrl');
  const claimTx = await transaction(claim, 'Winnings claimed');
  const { signer: claimant } = ixFrom(claimTx, 'claim_winnings', [[1, marketPda], [2, DEVNET_MUSDC]]);
  const winningMint = (winning === 0 ? market.yesMint : market.noMint).toBase58();
  const payout = tokenDelta(claimTx, claimant, DEVNET_MUSDC);
  if (claimTx.slot < resolved.slot || !tradedBy.has(claimant) ||
      payout <= 0n || tokenDelta(claimTx, claimant, winningMint) !== -payout) {
    fail('Claim must pay test mUSDC to a verified trading wallet and burn the winning tokens');
  }
  const openingPriceBps = Number(market.initialPriceBps);
  if (!Number.isInteger(openingPriceBps) || openingPriceBps < 0 || openingPriceBps > 10000) fail('Opening price unavailable');
  const proof = {
    schema: 'kult-fuse-devnet-lifecycle-v1', buildSha: sha, network: 'devnet', programId: PROGRAM_ID,
    collateralMint: DEVNET_MUSDC, publicUrl: origin.href, videoUrl: video.href, vaultPda, marketPda,
    verifiedAt: new Date().toISOString(), openingPriceBps, winningSide: winning === 0 ? 'yes' : 'no',
    wallets: { commitmentAddresses: fundedBy.size, tradingAddresses: tradedBy.size },
    selectedFundingMUsdc: Number(fundedRaw) / 1e6, selectedTradeMUsdc: Number(tradedMUsdc.toFixed(6)),
    claimMUsdc: Number(payout) / 1e6, resolutionEvidenceUrl: source.href,
    receipts
  };
  const output = process.env.PREDICT_PROOFS_OUT || 'predict-proofs.json';
  await writeFile(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  console.log(`SUBMISSION EVIDENCE PASSED — ${receipts.length} finalized lifecycle transactions. Wrote ${output}.`);
  console.log('Wallet counts measure distinct addresses. Tester independence and video content require human review.');
}

main().catch(error => {
  console.error('SUBMISSION EVIDENCE NO-GO — ' + error.message);
  process.exitCode = 1;
});
