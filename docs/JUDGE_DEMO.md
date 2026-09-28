# KULT Fuse — Judge Demo Runbook

## The 15-second thesis

**Prediction markets price the event. Perps trade the consequence. Fuse turns probability into a user-authorized execution mandate.**

The key trust distinction: the agent may propose a policy, but the program bounds what can execute after the user arms it.

## Recommended live demo

1. Open the app. Do not explain architecture yet.
2. Point at the four-stage flow: **Signal → Policy → Position → Proof**.
3. Click **RUN JUDGE DEMO**.
4. At 61%, show `$300` target/actual.
5. At 72%, show `$420` target/actual.
6. Let the Chaos Test inject 28%.
7. Pause on **KILL CONDITION TRIGGERED**.
8. Show target and actual both zero.
9. Open the independent verifier: **POLICY COMPLIANCE VERIFIED**.

## What to say

> The prediction market is not just something we trade. Its probability becomes state. Before execution, the user commits to a transparent probability-to-exposure curve and a hard cap. Once armed, the worker cannot ask Solana for a normal probability-driven target outside that curve. If probability crosses the failure threshold, the Fuse is permanently killed and can only reduce to zero. Every execution produces a hash-linked receipt that anyone can verify against the original policy.

## If a judge says “this is a conditional order”

> A conditional order is one trigger and one action. Fuse is a persistent state machine: at every valid probability, a precommitted policy defines the permitted target exposure. It continuously reconciles target versus actual venue exposure, has hard lifecycle constraints, and leaves a verifiable receipt history.

## If a judge says “why onchain?”

> The chain is the mandate. It proves the curve, cap and kill state existed before execution and lets anyone audit whether the executor stayed inside that mandate. The chain does not claim the agent was smart; it proves the agent/executor stayed authorized.

## If a judge says “what if the worker is compromised?”

> The updated Anchor program recomputes the compact curve onchain. Normal probability-driven target requests must match the onchain target exactly. Safety actions can only reduce risk. For full production, the next step is venue-scoped/PDA-controlled execution authority so the worker cannot bypass the program at the venue level either.

## Do not claim

- guaranteed profit;
- guaranteed maximum dollar loss from a stop;
- that a simulated Chaos probability move came from DFlow;
- that external venue fills are trustless unless the live integration actually proves them;
- atomic cross-venue execution unless implemented.
