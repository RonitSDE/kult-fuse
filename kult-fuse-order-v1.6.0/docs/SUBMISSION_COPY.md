# Submission copy · fill proof first

**Name:** KULT Fuse

**Tagline:** An event-conditioned perp order with a precommitted Solana mandate.

**Description:** A user selects a prediction event, a direct SOL-perp consequence and a bounded probability-to-exposure curve. Solana Fuse checks the targets the worker submits, while the venue adapter reconciles the actual position. The read-only verifier checks Drift fill evidence and matching Fuse receipt anchors. Stale or low-quality quotes do not add risk. An absorbing kill blocks new Fuse targets and the worker separately tries to close the venue position.

**Limitation to state plainly:** The worker's Drift key is not bound to Fuse. The worker can trade around the program. A Fuse kill is not itself a venue close. The oracle input is worker supplied.

**Evidence required before saying execution verified:** live quote, Fuse program/account and create/arm/target/kill explorer links, three Drift fill links for open/resize/close, actual close residual, verifier result, public URL and exact build SHA. A simulation is labelled simulation. If those links are absent, say 'No execution to verify'.

**Links:** fill from SUBMISSION_MANIFEST.json only after the deployer has checked them.
