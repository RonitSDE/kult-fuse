# Authority binding: the next milestone, not a claim

**Today:** the worker holds the Velocity trading key. Fuse checks every target the worker submits (curve, cap, expiry, kill), but a worker with that key could trade on Velocity directly. A refusal at Fuse is a refusal at Fuse, not at the venue.

**The bound version:** the agent cannot exceed the mandate because it has no other way to trade.

1. Velocity's own Vaults program (`vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`) already trades through a Velocity user account as its **delegate**. That is the precedent to follow: a Fuse-owned PDA becomes the delegate (or authority) of the mandate's Velocity subaccount.
2. Every order goes through a Fuse instruction that reads the committed policy, the fresh observation, the actual venue position, expiry and kill state, caps the order, applies limit + IOC terms and invokes Velocity with the PDA's signer seeds.
3. Reduce-only close stays allowed after a kill or during stale data.
4. The worker keeps no owner key, no other delegate and no withdrawal right.

**Acceptance:** send direct over-cap and post-kill orders to Velocity with every key the worker holds, and show both denied at the venue. Show a reduce-only close after kill succeeding. Rotate authority and recover an interrupted close. Run Anchor integration tests against the real Velocity program, get the account constraints audited, deploy fresh. Only then flip the dashboard's "venue key not bound" disclosure.
