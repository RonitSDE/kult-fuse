# v1.6.0 source handoff

The product remains one prediction informed SOL-PERP mandate with a live Polymarket quote, a committed curve, a small Drift order, independent fill and anchor verification, and an honest unbound venue key.

Changes since v1.5.0: expiry kills and closes even if the quote reader is unavailable; already-flat kills skip a phantom venue order; operator and worker state mutations are serialized; expiry close signatures appear in the proof panel; all test files run in the release gate; a read-only submission checker rejects missing public proof and independently verifies receipt events against RPC.

The source archive has no compiled program, generated IDL, current live Drift signatures, public URL or video. The included manifest is blank. The deployed program account, actual lifecycle and host must be proved on the same release commit before submission. The Drift wallet can bypass Fuse.
