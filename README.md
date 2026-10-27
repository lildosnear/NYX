# Nyx

Nyx is a security and payment control layer for AI agents. We think of it as the firewall between AI agents and your money.

Agents are starting to buy things to get their work done. They pay for APIs, data, tools and services. Today the owner has two bad choices. Give the agent payment details and hope it behaves, or approve every purchase by hand and lose the point of having an agent. We built Nyx so there is a third choice. The agent gets real spending power, inside hard limits the owner sets, and Nyx checks every payment before any money moves.

## What Nyx does

1. The owner sets the rules for each agent. There is a cap for each payment, a budget for each day, and a list of vendors the agent is allowed to pay.
2. The agent plans its work and asks a vendor for a signed price quote. Quotes expire, and each quote can only be paid once.
3. The agent submits the payment to Nyx. A policy engine checks the payment in a fixed order. The agent must exist and be active. The caller must be allowed to act for that agent. The quote signature must be valid. The quote must not be expired or already used. The vendor must be approved. The amount must be within the cap. The daily budget must have room.
4. Payments inside the rules settle at once and produce a receipt.
5. Payments outside the owner rules wait in an approvals queue. The owner reads a plain English risk summary and can approve that one payment as an exception, or deny it with a reason. No money moves while a payment waits.
6. The owner can pause an agent at any time, which blocks all of its payments, or revoke it, which ends its access at once.
7. Every attempt is recorded. A receipt can say one of three things, and the three are kept separate on purpose. Settled means money moved and budget was used. Blocked by policy means the payment was never attempted. Execution failed means the payment was attempted, the provider failed it, and no budget was used.

One rule never bends. The daily budget is an absolute ceiling. Even an owner approved exception counts against it, and a payment that would pass the ceiling is blocked.

## The model explains, the engine decides

The agent in this project plans purchases and explains risk. That work is done by Muse Spark through the Meta Model API, behind the model adapter interface in the agent package. When a MODEL_API_KEY is present in the environment, the system uses the Meta adapter. When it is not, a deterministic mock adapter fills the same place. That way the full system runs and can be tested with no key, and runs on the real model with one. You can check which mode is live at any time by opening the model status endpoint in the api, at /api/model/status. It reports the mode and the model name, and it never exposes the key.

The payment decision never comes from a model. It comes from the policy engine, which follows fixed rules in code. A language model can be persuaded or tricked by text it reads. The demo proves why that separation matters. In the last scene, a vendor response tries to talk the agent into buying an expensive list from a vendor the owner never approved. The agent tries it. Nyx holds the payment and no money moves.

## What is in this repo

1. The core package holds the types, the signed quote system, the budget ledger, the policy engine, the approvals store, the receipt store, and the payment provider interface with a sandbox provider that simulates test mode charges.
2. The merchants package holds four mock vendors that issue signed quotes. Three are on the owner approved list. One is not, and it exists for the blocked scenes.
3. The agent package holds the model adapter interface, the Meta adapter, the mock adapter, the agent runner, and the injection scenario.
4. The api app serves the owner endpoints and the dashboard.
5. The web app is the owner dashboard. It has five views. Overview, Agents, Policies, Payments with blocked attempts, and Approvals.
6. The tests folder holds the automated tests. They cover the cap, the daily budget, quote expiry, replay, callers who are not authorized, pause, revoke, approving and denying, ten payments racing one budget, a forced provider failure, and the injection scenario.
7. The scripts folder holds the demo entry that runs the five scenes in order and prints a pass or fail line for each check.

## Run it

You need Node 20 or newer.

1. Run npm install in this folder.
2. Run npm run build to compile everything.
3. Run npm test to run the full test suite.
4. Run npm run demo to watch the five scenes.
5. Run npm run api and open the dashboard in your browser at the address it prints, on port 8390 by default.

The demo scenes are the product story in order. A payment inside the rules settles. An over cap payment is held. The owner approves that one payment and it settles. A paused agent is blocked, and a revoked agent is blocked. An injection attempt is held and no money moves. After the scenes, the demo also checks a replayed quote, an expired quote and a caller the owner never authorized.

## Demo settings

The demo agent starts with a cap of five dollars per payment and a daily budget of fifty dollars. The approved vendors sell a market data set for 2 dollars 40, a weather feed for 1 dollar 20, a research brief for 4 dollars 80, a deep research report for 9 dollars, an icon pack for 3 dollars and a brand kit for 4 dollars 50. The vendor the owner never approved sells a premium leads list for 7 dollars 50.

## What is stubbed

The mock model adapter is a fallback on purpose. It plans purchases with simple rules and writes risk summaries from templates. It runs when no Meta Model API key is present, and the Meta adapter also falls back to it when an API call fails, because the runner and the engine only ever talk to the interface. To run on the real model, set the environment variable MODEL_API_KEY to your Meta Model API key before starting the api or the demo. The model used is muse spark 1.3, called through the Meta Model API at its standard endpoint. No key is stored anywhere in this repo. For local development through a connector proxy, set MODEL_API_KEY to any non secret placeholder and set META_BASE_URL to the proxy address, for example http://127.0.0.1:8787/v1. The proxy forwards each call to Meta, so the app never needs to hold the real key. On your own machine, use the real Meta key and leave META_BASE_URL unset.

Nyx can also carry a second model beside Muse Spark. Set SECOND_MODEL_PROVIDER to fireworks, baseten or modal, SECOND_MODEL_API_KEY to that provider key, and SECOND_MODEL_ID to the open weights model to run. Fireworks and Baseten have known base addresses built in. Modal serves each deployment at its own address, so Modal also needs SECOND_MODEL_BASE_URL. The second model only plans and explains, exactly like the primary model, and it never decides a payment either. Run npm run benchmark to compare every configured model on the same task and the same held payment. The dashboard overview shows when a second model is live.

Payments run through the sandbox provider, which simulates test mode charges and can be told to fail the next charge. A real provider in test mode can sit behind the same interface later. The stores are in memory, which is right for the hackathon build and the demo. Nothing in this repo moves real money.

## Our principle

The enforcement path is the product. A polished dashboard cannot make up for a policy engine that has never been attacked, so we attacked ours first and kept the evidence in the tests and in the blocked attempts view.
