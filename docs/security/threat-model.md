# Ellai threat model

Written at the architecture gate on 2026-10-20, before any code, by a separate review pass working only from Ellai's functional system description. Ellai is self-audited; this file is the definition of done for the backend: the implementation is complete only when every invariant in section C is upheld in code, with the file and function named.

Chosen design (Ram, 2026-10-20): Option 1 below. Ellai fetches the seller's payment challenge itself, decides, and pays from a per-owner purse with a plain gasless USDC send, on Sui Mainnet. Owners' USDC stays in their own address behind a native Sui allowance (total cap, daily limit, expiry, revocable).

References in brackets (for example "walrus BRIEF 8.1") point to the project's private research notes.

## A) App-class risk profile

In security terms Ellai is four things at once. In order of weight:
1. **A money signer.** It spends money when a semi-trusted caller (the agent) asks, on payment terms written by an untrusted third party (the seller). In plain terms, it is an automated cheque-signer.
2. **An approval engine whose rules run on looked-up evidence.** The fixed rules take their evidence from a similarity search over a store that partly holds text an attacker wrote. The typical failure for this kind of system is evidence that has been poisoned or steered.
3. **A shared system for many users.** Owners and anonymous demo sessions share one server key set, one Walrus Memory delegate key, and possibly one purse key.
4. **A relay for attacker text and a fetcher of attacker-chosen web addresses.** It shows attacker text in the owner UI, on /proof, and to LLM agents over HTTPS and MCP. The demo agent fetches seller URLs from inside the server.

Risk categories, each tied to a flow:
- **A1. Paying the wrong party.** The agent sends the seller URL and the raw challenge. Step 1 parses them, step 4 applies rules keyed "for this seller", and step 6 pays "the seller's recipient". Trust earned by host H ends up paying recipient R, and nothing links H to R. This is the most severe risk.
- **A2. Parser mismatches and normalisation.** Step 1 reads three dialects: x402 v1 `maxAmountRequired`, x402 v2 `amount` in a base64 header, and MPP's base64url request. Each value then reaches five consumers: the rules, the owner's question screen, the executor, the verifier (step 7) and the memory text. If any two parse a value differently, the amount that was checked is not the amount that gets paid. This covers:
  - challenges with several `accepts` entries, or a header and body that disagree
  - addresses written short or long, or in different case
  - coin type tags written in different forms
  - hosts that differ by case, lookalike (IDN) characters, a trailing dot, or a port
- **A3. A signer used for things it was not meant to sign.** The purse key signs USDC sends. In the MPP dialect it also signs a personal-message proof over seller-chosen `challengeId` plus amount, currency, recipient and digest. The gas wallet signs refills as sponsor. Any path that lets attacker-shaped bytes or strings reach a signer turns that key into the attacker's signer.
- **A4. Replays, double payments and races.** Money can leak through:
  - idempotency keys and the poll endpoint, which hands out payment material
  - the daily budget being checked in step 4 while money leaves in step 6
  - signed bytes held by an agent or seller who broadcasts them late or never
  - a seller who issues a fresh 402 after being paid
  - owner approvals given after a challenge has expired
- **A5. Poisoned or steered memory.** This is central to the product. Step 2 builds the search query from the agent's purpose text and the seller host. Step 3 searches by meaning, step 4 counts the results, and steps 5 and 7 write new memories that later searches will return. The agent therefore partly steers which evidence comes back. Search also returns the closest K matches even when none are relevant, cuts results at a limit without saying so, lags behind writes, and lets memories expire without notice (walrus BRIEF 8.1).
- **A6. Leaks between users, and fetching other users' records by id.**
  - All namespaces live in one account under one delegate key, and namespaces are labels, not walls (walrus BRIEF 4.6).
  - `GET /api/agent/decisions/{id}` could return another owner's decision.
  - The owner API lists memories, payments and tokens.
  - Purse and refills may or may not be separate per owner.
- **A7. Server-side request forgery** (the server fetching a URL an attacker chose). The demo agent makes GET and POST requests to sellers from Ellai's server. If Ellai fetches the seller URL itself to close A1, every pay-request becomes an outbound fetch to an address the agent named.
- **A8. Attacker text reaching a page or an LLM as instructions.** Purpose text, seller host, challenge fields, owner reasons, memory text, chain strings (namespace attributes) and seller response bodies all reach the owner UI, the demo UI and /proof. Reason text reaches external LLM agents over HTTPS and MCP, where it can be read as instructions. A script injected into the owner UI gives the attacker the approve button.
- **A9. Sign-in and sessions.** Owners sign in with a wallet personal-message signature and get a cookie. Agents use bearer tokens, which also sit in MCP config files. Demo sessions are anonymous. Owner actions that change state (answer a question, issue or revoke a token) ride on the cookie. The risks are a replayed sign-in signature, cross-site request forgery on approve, stolen tokens, and an exposed demo session id.
- **A10. Treating a failed dependency as a "yes".** Recall can error, return a 429 dressed up as a 500, time out with 504, or come back empty right after a write (walrus BRIEF 8.1, 8.3). Tatum can be down or behind. Memory jobs can stall. Any path where "no data" reads as "no refusal" or as "verified" ends in a payment.
- **A11. Draining shared budgets and quotas.** Targets include:
  - an unbounded number of anonymous demo sessions
  - public /proof and landing counts that read chain data
  - one relayer rate budget shared across everyone (builders report 60 per minute per key, walrus BRIEF 8.2)
  - Tatum credits, which are lifetime (tatum BRIEF 8 item 3)
  - gas wallet SUI spent on refills
  - floods of pending questions
  For a hackathon, the cost is a demo that dies in judging week.
- **A12. Secrets and bearer values leaking.** The env holds seven secrets. Signed transaction bytes and MPP proofs work for whoever holds them until they are used. Agent tokens sit in agents' MCP configs. Namespace names are public on chain. The relayer operator and the embedding provider see memory plaintext (walrus BRIEF 4.8).
- **A13. Owner privacy.** /proof lists every payment and every memory blob across all owners. Reason text sent to agents might quote private memories.

Categories that do not apply, or apply only narrowly:
- **SQL injection, shell commands:** narrow. No flow builds a query or a shell command from text. Postgres does store attacker text (purpose, reasons, raw challenge), so parameterised queries are still required (C24).
- **File upload and path traversal:** do not apply. No flow accepts files or paths.
- **XML and unsafe object decoding:** no XML anywhere. Challenges are JSON and base64 JSON, covered by A2's size and nesting caps. The one narrow case is prototype pollution, if Node code merges raw challenge JSON into an object.
- **Smart contract bugs:** none in options 1 and 2, which use only the framework allowance. Option 3's module brings them in (see O7).

## B) Threat model

**Trust boundaries**
- **T1. Agent to Ellai** (HTTPS and MCP, bearer token). The agent is the party the gate exists to restrain. Treat it as possibly malicious, compromised or prompt-injected, even though the owner issued its token.
- **T2. Seller to Ellai.** This covers the 402 challenge (which the agent carries, so it crosses T1 too), seller responses to the demo agent, and what the seller does after being paid.
- **T3. Browser to owner API.** Wallet sign-in, the session cookie, owner answers and reasons, plus cross-site requests that ride the cookie.
- **T4. Anonymous browser to the demo.** Starting sessions, starting the demo agent, and demo answers.
- **T5. Walrus relayer to the decision engine.** Search hits, distances, ordering, job status and blob ids. The text inside them crossed T1, T2 or T3 earlier.
- **T6. Tatum gateway to the verifier, refills, balance checks and /proof.** Transaction effects, balances, objects and the owner's blob lists.
- **T7. Sui chain state to Ellai.** Anyone can create objects or send coins to an owner, purse or gas address. Anyone can create an allowance that names the purse as spender.
- **T8. Postgres read-back to the UI, rules and scheduler.** Rows hold attacker text that was written earlier.
- **T9. Ellai outward.** Payment material goes to agents and sellers. Memory text goes to Walrus, and so to the relayer operator and the embedding provider. Strings go to LLM agents, and data goes to public pages.

**Attacker-controlled inputs**

Direct:
- The agent token: guessed, reused after revocation, or stolen from an MCP config.
- The seller URL: scheme, userinfo, host (case, lookalike characters, trailing dot), port, path.
- Every field of the raw challenge:
  - money and destination: `amount` or `maxAmountRequired`, asset type, `payTo` or recipient, network
  - identifiers and timing: `nonce`, `challengeId`, expiry, `minEpoch` and `maxEpoch`, `maxTimeoutSeconds`
  - descriptive fields: `realm`, `resource`, `extra`
  - structure: how many `accepts` entries there are, header copies versus body copies, base64 and base64url encodings, size and nesting depth
- Purpose text, which also becomes the search query and memory text.
- The decision id on the poll endpoint, and MCP tool arguments.
- The idempotency key, if the client supplies it.
- The sign-in message, signature and claimed address; the session cookie; the demo session id.
- Owner answers, reason text and token labels.
- The number of demo sessions, and the demo task's inputs.
- Request headers: Origin, Host, Cookie, Content-Length, and any header used for rate limiting (for example X-Forwarded-For).

Indirect:
- What the demo agent receives from sellers: 402 bodies and headers, redirects, the IP a seller host resolves to (which can change between the check and the connection), slow or oversized responses, and the resource body after payment.
- What sellers do after payment: never broadcast signed bytes, broadcast and claim failure, issue a fresh 402 after being paid, or rotate recipient addresses.
- What comes back from search:
  - memory text holding purpose text, hosts and reasons written earlier
  - distances, rank order, cut-off at K, and empty or failed results
  - memories written by other delegates or MCP tools on the same account
  - memories from other namespaces
- Job status and blob ids from the relayer.
- Tatum answers: effects, balance changes, statuses, balances, object lists, errors and stale reads.
- Chain objects: Blob objects and coins sent to owner, purse or gas addresses, and allowances from any funder that name the purse.
- Postgres rows read back: purpose, reasons, raw challenges and decision states.
- Outcome memories Ellai itself wrote from results a seller influenced.
- Time: how long the owner takes to answer versus the challenge expiry, and epoch numbers.

**Privileged position and assets**
- **Purse signing key.** It can send the purse float anywhere with a gasless send. As the allowance spender, it can also pull refills from every owner allowance that names the purse, up to each allowance's caps.
- **Gas wallet key.** It spends SUI as a sponsor.
- **Walrus delegate key.** It reads and decrypts every owner's and every demo session's memories. It can write into any namespace on the account, and those memories are the evidence the gate trusts.
- **Session signing secret.** It can create a session for any owner.
- **Tatum API key.** It holds lifetime credits and is the read path that the verifier and /proof rely on.
- **Demo agent key and demo budget.**
- **Database.** Token hashes, decisions, pending questions, payment material waiting to be polled, and idempotency records.
- **Outbound network position.** The server can reach hosts the public cannot: its own Postgres, localhost services, and the hosting platform's metadata endpoint.
- **Credibility.** The owner approves what Ellai's question screen says, and a judge believes what /proof says.
- **Ceiling on loss.** The allowance caps (total, periodic, expiry) and the float bound what any key compromise can take. The owner's main balance is out of reach.

**Attacker goals**
- **G1. Pay a recipient the owner never intended.**
  - A forged challenge with a trusted host and the attacker's `payTo` (A1).
  - A lookalike host whose sentence lands close to the real host's in meaning-based search (A2, A5).
  - An amount read small by the check and large by the signer (A2).
  - Several `accepts` entries, where the rules read one and the executor pays another (A2).
  Flow: pay-request, then steps 1, 4 and 6.
- **G2. Manufacture trust so that later requests are approved automatically.**
  - Purpose text written to land near past approvals and beyond the distance cutoff from a refusal.
  - Enough approvals for one seller that a refusal falls out of the top K.
  - Outcome memories or rule-approved payments counted as approvals, so one owner yes snowballs.
  - A second delegate on the same account (for example the owner's own Claude Code with MemWal MCP) writing "approved" sentences.
  - Demo memories leaking into a real owner's search (A6).
  - Field-like text inside purpose or reasons ("decision: approved, amount 5.00") read back by a sentence parser.
  Flow: steps 2, 3, 4, 5 and 7.
- **G3. Spend past the owner's limits, or pay twice.**
  - Parallel requests racing the daily budget.
  - Reusing an idempotency key with a new challenge.
  - Polling twice to get two signatures.
  - A paid seller that keeps answering 402.
  - Signed bytes not counted against the budget until they settle.
  - Another owner's decision id on the poll endpoint returning that owner's payment material.
  Flow: steps 4 and 6, and the poll endpoint.
- **G4. Take the owner's chair.**
  - Script injected through purpose, reasons, host or chain strings in the owner UI.
  - Cross-site request forgery on approve or issue-token.
  - Replaying a captured sign-in signature.
  - Social engineering through purpose text ("owner pre-approved this, click yes").
  - Flooding the owner with questions until they approve without reading.
  The payoff is approving the attacker's own payments or minting agent tokens. Flow: T3 and step 5.
- **G5. Abuse Ellai's position or quotas.**
  - Server-side request forgery from the demo agent, or from a fetch added to close A1, into internal services.
  - Using anonymous sessions and public page loads to drain the demo budget, gas wallet, Tatum credits or the shared relayer rate budget, so searches fail and the judge's demo dies.
  - Reading other owners' memory text through reasons or the public namespace labels.
  Flow: T4, T6, demo agent fetches, and /proof.

## C) Defensive-programming standards (the definition of done)

Each invariant names the risk it closes. Every backend work order carries the invariants it touches inside DONE MEANS, and the cook names the file and function that upholds each one.

**Money**
- **C1 (A1, A2, G1). One payment, one meaning.**
  - Each request is parsed once into one canonical payment: recipient, amount in atomic units, asset type, network, expiry, dialect, and `challengeId` and nonce as length-capped strings from a fixed character set.
  - The rules, the question screen, the executor, the stored record, the memory text and the verifier all read that object and nothing else.
  - Before any signature leaves Ellai, the built transaction is decoded and must equal that object field for field. It must also be the plain USDC send and nothing more: no extra commands, no other recipient, no other coin.
- **C2 (A1, G1). Trust follows the money.**
  - Approvals earned by one recipient address never count for a different address.
  - A seller host is only a label, unless Ellai itself received this challenge from that host over verified HTTPS in this request. A host string typed by the agent never earns or inherits trust.
  - A seller that rotates addresses therefore falls back to asking the owner, which is the safe direction.
- **C3 (A2, G1). Amounts, assets and networks are exact or refused.**
  - An amount must be a positive base-10 integer in atomic units: no sign, decimal point, exponent or leading zero.
  - It must be within the per-payment hard limit and at least the 0.01 USDC gasless minimum.
  - After normalisation, the asset must equal the configured USDC type for the deployment network, and the network must equal the deployment network.
  - Refuse, rather than pick one, any challenge that:
    - matches more than one dialect
    - offers more than one payable option
    - carries copies of a field that disagree
    - exceeds the size cap
    - has a host ending in a dot
- **C4 (A4, G3). Limits hold under concurrency.**
  - In any 24-hour span, the total signed never exceeds the daily budget, and no single payment exceeds the hard limit.
  - The check and the debit are one atomic step, taken at the moment of signing, and they count everything signed, not only what has settled.
  - The step repeats when an owner's approval is turned into a signature.
  - A signed payment is released from the budget only after its validity window has closed and the chain shows it did not land, on two separate passes at least 30 minutes apart, so one lagging read can never free the budget. A paid call's own inline check never releases. Refills follow the same rule.
  - A transaction that landed but failed on chain moved no USDC, so it is released without pausing the owner.
- **C5 (A4, G3). One decision, at most one payment.**
  - Polls, retries and idempotent replays return the identical stored material, never a fresh signature.
  - A stored result comes back only when the full canonical request matches. A reused key with any difference is refused.
  - Ellai hands payment material out only inside a short window it sets, whatever expiry the challenge asks for. Once out, the material stays valid on chain until its ValidDuring epoch window closes, because Sui does not yet accept a timestamp bound on a transaction (dry run, 2026-10-25), so C25 counts it against the budget until then.
- **C6 (A3). Keys sign only what Ellai built.**
  - The purse key signs only the C1 send and the refill transaction.
  - The MPP proof is a personal message that Ellai serialises from C1 fields and the digest it computed itself.
  - No endpoint, tool or job passes caller bytes or caller strings to a signer.
  - The gas wallet sponsors only refill transactions Ellai built, and only within C23's bounds.
- **C7 (A6, G3, G5). Each owner's money pays only that owner's agents.**
  - A payment for owner X is sent from X's purse only.
  - A refill for X spends only from an allowance read from chain at refill time, whose funder equals X's signed-in address and whose spender equals X's purse. An allowance id taken from a request is never trusted on its own.
  - Demo money pays only recipients in the demo seller set Ellai operates. That set is a closed list on purpose, naming the only places demo money may go. It is not a deny list.
- **C8 (A10, G1). Verification uses Ellai's own facts.**
  - Settlement is checked against the digest Ellai computed from the bytes it signed, never a digest reported by an agent or seller.
  - The result is "verified" only when the effects show all of the following, compared with the same normalisers as C3:
    - success
    - a debit of the approved amount from that owner's purse
    - a credit of the approved amount to the approved recipient, in the approved asset
  - A mismatch, or a check that cannot finish within its limit, pauses automatic approval for that owner until the owner reviews it.

**Decision memory**
- **C9 (A5, A6, G2). Only the owner's own answers earn trust.**
  - A memory counts toward approve or refuse only when Ellai's own records show that Ellai wrote it, for this owner, as an owner decision.
  - These carry no weight:
    - outcome memories
    - payments approved by the rules
    - memories written by any other delegate or tool
    - memories from another namespace or a demo session
    - blobs that merely sit at the owner's address
  - The gate cannot teach itself, and an agent cannot write its own approvals.
- **C10 (A2, A5, G2). Rules read structured facts, not sentences.**
  - The decision, recipient, amount, owner and time that a rule uses come from Ellai's structured record for that memory, never from parsing the sentence that search returned.
  - Search decides which records are relevant. It cannot change what a record says.
  - "At or above this amount" compares integers.
  - The distance cutoff decides which past answers an honest agent's request resembles. It is not a defence against a hostile agent, which can repeat the purpose text of requests the owner approved. What bounds a hostile agent is the rest of the rule: only recipients the owner approved, at or below the approved amount, within the daily budget, and a new agent key needs the owner's wallet signature (C36).
- **C11 (A5, G2). A refusal always wins.**
  - A past owner refusal for the canonical recipient blocks automatic approval regardless of purpose text, distance cutoff, top-K cut-off, index lag, memory expiry, or how many approvals exist.
  - The refusal check is therefore an exact lookup by recipient in Ellai's own store, not a similarity search.
  - It runs again under the owner lock at signing, so a refusal answered between deciding and signing still wins.
  - The lookup keys on the owner and the canonical recipient, never on a namespace label.
- **C12 (A10). No answer means ask.**
  - The outcome is "ask", or "refuse" when a hard limit applies, never "approve", if a search:
    - errors or times out
    - returns a 429 or a 5xx
    - comes back empty
    - returns a hit without a numeric distance
    - reaches its result limit with its farthest hit still inside the owner's cutoff and too few visible approvals
  - Search serves only approvals: refusals (C11) and bad outcomes (C32) are exact lookups in Ellai's own tables. A result cut by its limit can therefore only hide approvals, so enough visible approvals are enough.
  - An owner answer binds future decisions from the moment Ellai records it, whether or not its memory write has finished.

**Identity and authority**
- **C13 (A6, A9, G3). Everything comes from the authenticated principal.**
  - An agent token resolves to exactly one owner through a constant-time hash lookup.
  - Owner, namespace, purse, budget and rate limits come from that lookup, never from a request field.
  - A decision, its reasons and its material go only to the token that created it.
  - Revoking a token stops new decisions at once, and stops any signature for that token's pending ones from then on (C35).
- **C14 (A9, G4). A sign-in signature works once, for Ellai, for minutes.**
  - Accept it only for a message that names Ellai's domain, a nonce the server issued and has not seen used, and an expiry.
  - The session principal is the address recovered from the signature, using the same address normaliser as everywhere else.
  - Every action that changes state needs a session cookie (HttpOnly, Secure, SameSite) and a same-origin check.
- **C15 (A8, G4). The owner approves exactly what will be paid.**
  - The question screen shows C1's recipient, amount, asset and network, visibly set apart from agent and seller text.
  - An owner's yes becomes a one-time grant for the agent's retry: the same agent, the same recipient, at most the approved amount, the same seller URL, method and body, within 10 minutes, used once. Anything else, or a grant expired or used, authorises nothing.
  - Pending questions are capped per token (C22).
- **C16 (A7, A9, G5). The built-in agent is just an agent.** It goes through the same gate, limits and owner checks as an external agent, buys only from Ellai's seller catalog with the catalog's URL and method whatever the model asks, and has no in-process path to a signer. The model never approves a payment.

**Outputs**
- **C17 (A8, G4). Attacker text stays text.**
  - Purpose, host, challenge fields, reasons, memory text, seller bodies, chain strings and the built-in agent's model text (which a seller body can steer) render as plain text in every UI, /proof and the docs. Never as HTML, never auto-linked.
  - Outputs to agents, over HTTP and MCP, carry Ellai-written reasons and memory ids. They never include memory sentences, and any field echoed back is marked as quoted data.
- **C18 (A8, A13, G5). Public pages show only what Ellai did.**
  - /proof and the live counts list only payments and blobs that are in Ellai's own records and confirmed on chain. Anything else found at an owner, purse or gas address is ignored.
  - A memory counts as confirmed on chain only once its blob id is found on a certified, unexpired Walrus Blob object owned by the owner, read through Tatum; the relayer's word is not enough.
  - A page cap can prove presence, never absence: a listing cut short defers the rest to a later read and never stops it.
  - A memory leaves /proof once the Walrus epoch reaches the end its Blob was stored until.
  - The public memory map (/api/public/memory-map, drawn on the landing page) follows the same rules: opted-in owners with something on chain, chain-confirmed unexpired answers only, citations only to such answers, host labels, amounts and distances, and never a sentence, purpose, reason, owner id, agent id or address. It reads Ellai's database alone, cached a minute.
  - An owner's payments and memories appear on a public page only if that owner opted in, since each digest leads to their wallet (Ram, 2026-10-25).
  - No memory text appears on a public page.
- **C19 (A12). Secrets and bearer values stay put.**
  - Keys, agent tokens, cookies, signed transaction bytes and unused proofs never appear in logs, error messages, memory text, namespace names, URLs or public pages.
  - Namespace labels are opaque and authenticate nothing, because they are public on chain.
  - Memory sentences contain nothing the owner would not show the relayer operator.

**Network and limits**
- **C20 (A7, G5). No outbound request reaches anything the requester could not reach from the public internet.**
  - HTTPS on port 443 only.
  - Resolve the host once, check the address with one "public unicast" predicate, then pin the connection to that checked address.
  - Do not follow redirects, or give every hop the same check.
  - Send no Ellai credentials, cookies or agent tokens to sellers.
- **C21 (A10, A11). Every external call is bounded.**
  - Calls to sellers, the relayer and Tatum each have a timeout, a response size cap and a retry ceiling.
  - A library call that makes requests of its own (the Walrus Memory SDK) gets an outer time limit as well, since its inner steps may have none.
  - Every polling loop (memory jobs, settlement, balances) has an iteration ceiling and ends in an explicit failed state the owner can see.
- **C22 (A11, G5). Anonymous traffic cannot spend shared quotas.**
  - No public or anonymous request triggers a paid upstream call per request. Public pages read a cache refreshed on a fixed schedule.
  - Where an anonymous request must reach a paid upstream (Ellai's seller sending a buyer's payment, a zkLogin check), it does so only inside per-client and global daily caps sized to the credit budget, and a capped request never calls upstream.
  - Any wallet can sign in for free, so owner routes that read the chain have a cap across all owners as well as per owner.
  - Background work reads the chain only when Ellai's own records say there is something to learn: an idle owner costs nothing. A chain answer that cannot change until Ellai's records change (an allowance that can no longer pay, a full rate window) is recorded and not asked again until then.
  - One meter stands in front of every request to Tatum, from routes, jobs and library calls alike. It charges each request to a daily budget for whoever started it (the client, the owner and their agents, everything people can start together, and the jobs tick apart from all of those), and refuses any request whose starter is unknown. A new path cannot spend credits outside a cap, because it cannot reach Tatum without passing the meter.
  - The demo has global caps on live sessions, demo spend per day and memory writes per hour, and they hold however many sessions exist.
  - Pay-requests and pending questions are capped per token and per owner.
  - Rate limits key on the platform's verified client address, never on a header the client sets.
- **C23 (A3, A11). The float stays small.**
  - The purse balance never exceeds the configured float, even when a balance read is wrong. Refills happen only below a threshold, at most N per window, each of a fixed maximum size.
  - On chain, the float is the true per-payment cap, because a plain send has no cap of its own.
  - The refill rule trusts the larger of the chain read and Ellai's ledger, which is safe only while every purse outflow is a payments row. Any new way out of the purse (an owner sweep, a withdraw) must be written to the ledger first, or refills stop.
- **C24 (A2). Stored text is never code.** Every query is parameterised. Every parsed challenge is a fresh object built from known fields, never a merge of the raw JSON.

**Added at the backend review (2026-10-25)**
- **C25 (A4, A10). The budget counts liability, not age.**
  - Every unreleased payment still pending counts against the daily budget, however long ago it was signed. A settled payment counts for 24 hours from signing.
  - One function defines what counts, and decide and signing both read it, so they never disagree about what is left.
- **C26 (A4). Clocks are read after I/O.** An expiry or window check uses a time read after the last network call it depends on, inside the lock that guards the write it allows.
- **C27 (A10, A3). No single read is truth.**
  - A missing entry in a chain answer is unknown, not zero.
  - A refill is decided on the larger of the chain read and Ellai's own ledger, so a wrong read can only refill less.
- **C28 (A10, A11). Every owner gets a turn.**
  - The jobs tick takes owners least recently visited first, stamps each visit when it starts, and starts no external call past a deadline set so the slowest single call, with its retries, still ends inside the route's limit. Every owner with pending work is visited within a bounded number of ticks however many owners there are.
  - Any count toward a verdict (failed settlement reads, write attempts) lives on the row it judges, so it outlives however long the rotation takes.
- **C29 (A1, G1). Ellai's own seller never closes a sale on an unknown outcome.**
  - When it cannot tell whether the buyer's bytes landed, it reads their digest, settles and delivers if the chain shows the payment, and lets the same payment resume.
  - It rejects only on a definite refusal or a mismatch. A refusal after an earlier send is never definite. Rechecks are limited per sale, and a sale whose window closed without the payment is closed for good only after repeated misses.
  - Settling and delivering are recorded apart: a buyer whose payment settled but whose check failed is served again for the same payment, up to a fixed number of times, then told plainly it will not be tried again.
- **C30 (A3, A11). The gas wallet signs only after a successful dry run.** A refill is simulated first and sent only when the dry run succeeds and moves exactly the refill, and only when the allowance's current window still has room for it.
- **C31 (A2). Repeated JSON keys are refused.** A challenge body or header copy that repeats a key at any level is refused, since parsers disagree on which copy wins.
- **C32 (A5, G2). A bad outcome makes Ellai ask from the moment it happens.**
  - A payment that landed or may still land and was not delivered (delivered false or unknown), or a mismatch, blocks automatic approval to that recipient.
  - The block lifts only at an owner's yes to a question asked after that payment's outcome was last recorded, so a yes the owner gave before a seller failed never clears the failure.
  - The reason shown is the worst one: a mismatch, then a delivery that failed, then a delivery not yet seen.
- **C33 (A10, A11). Every memory write ends.**
  - Each write reaches Walrus or a visible failed state within a set number of attempts and a set age, and one refused write never holds back the owner's others.
  - Only a refusal about the write spends an attempt. A rate limit or an outage only ages it.
  - No database transaction or row lock stays open across a relayer call. A row being written is leased for longer than the call can take, and a write accepted but never recorded is an orphan blob Ellai never cites (C9).
- **C34 (A11, G5). Every per-client limit has a global cap.**
  - Anonymous work (sign-in nonces, zkLogin checks, seller challenges) is capped across all callers as well as per client, and its rows are pruned on a schedule.
  - Cleanup outpaces the caps: every table anonymous callers can fill loses at least as many rows a day as the caps let in, through an indexed key, within a time slice of its own.
  - Caps bound arrivals, so rows standing are a cap times how long each row is kept. That product fits the database plan for every such table, per-client rate counters included, and sign-ins have daily caps because each can create an owner row.
  - Free wallets can own agents, so agent pay-requests have per-client and global daily caps (20,000 a day), and decisions that closed without a payment are pruned after 30 days: at most about 600,000 of those stand. Answered decisions, with their questions and memories, are the owner's own record and are kept; the pay-request caps bound how fast they arrive.
  - Callers with no owner, each owner's background work, and refills have budgets of their own, so strangers cannot spend what owners need to pay and one owner cannot spend another's share. Owners who each spend their whole share can still, together, use up the shared background day; that takes several funded wallets with step-up signatures, refills keep their own pool, and it is accepted and logged.
  - A sign-in nonce is burned before any chain check or shared quota, so a failed attempt cannot be retried on it and one caller cannot spend the shared quota without spending nonces.
  - Shared caps on paid upstream calls are sized to the credit budget. Exhausting one can lock out everyone using that path until the window ends; that is accepted, logged, and bounded per client.
  - IPv6 clients are keyed on their /64, since one host can hold the whole prefix.
- **C36 (A9, G3, G4). Loosening needs a fresh signature.**
  - Creating an agent key, raising the per-payment maximum or the daily budget, lowering the approvals needed, raising the distance cutoff, resuming automatic payments, clearing an automatic pause, or turning the public proof page on each needs a signature from the owner's wallet, made within minutes, over a message that names that exact change. The signature works once, for that owner and that change only, and a failed one burns its nonce.
  - Tightening needs only the session.
  - Answering questions and starting a built-in agent task need only the session, by Ram's choice: a stolen session can approve what agents ask for and run the built-in agent, which buys only from its catalog, up to the daily budget. It cannot pay anyone outside the catalog or past the budget, every payment is in the owner's history, and the owner can end every session at once or pause.
  - A stolen session cannot use up the owner's step-up or agent-create allowance: each is counted per session as well as per owner.
- **C35 (A6, G3). Revoke and sign share the owner lock.** Revoking an agent takes the owner row lock that signing takes, so a revoke lands either before a signature, which then refuses, or after it, when that payment is counted and verified like any other.
- **C37 (A8, G2). Public words come from the right field.** (Added after the section 13 review, 2026-10-28.)
  - A public page says money moved only for a decision with a payment Ellai verified on chain by its own digest, and states a decision's cause only from its stored rule, never from its outcome alone.
  - A decision reaches a public page only when it has a verified payment, cites at least one owner answer that is on chain, or its own question's answer is an owner answer on chain. Limit refusals, unanswered questions and unpaid grants stay private. So an opted-in owner cannot put a host on the landing page without either paying it or answering about it on Walrus.
  - The opt-in text names every kind of row it puts on a public page.
- **C38 (A6, A8, G4). The purse is never out of sight.**
  - The owner sees the purse's USDC whenever Ellai's ledger says it may hold any, with or without an allowance recorded.
  - Every pending refill reaches a final state, whether or not an allowance is still recorded; forgetting an allowance never strands a refill row.
- **C39 (A6, A9, G3). Ellai relays owner-signed transactions only as it built them.**
  - Ellai sends a transaction the owner signed in the app only when the bytes equal a fresh build for that owner and step, from the owner row, with the owner as sender and gas owner, metered under C22.
  - Fields the relay does not check, by design: on the Walrus Memory account steps, the gas coins, gas price and expiry the owner's wallet chose. The owner signed them and pays for them; a stolen session cannot produce the signature.

**1. Primitives over lists**
- **Addresses and coin types:** one normaliser from the Sui SDK on every side (`normalizeSuiAddress`, `normalizeStructTag`).
  - Covers: case, the 0x prefix and zero padding.
  - Does not cover: whether an address belongs to the business a host claims. C2 handles that.
- **Payment shape:** the rule is "the decoded transaction equals a fresh build from the canonical payment", not a list of allowed Move calls.
  - Covers: extra commands, other recipients and other coins.
  - Does not cover: a payment that should never have been approved.
- **Seller trust:** the rule is "the owner refused this recipient" (C11), not a hand-kept list of bad sellers.
- **Outbound address check:** one library predicate for public unicast, applied after unwrapping IPv4-mapped IPv6 (for example ipaddr.js `range()` equal to unicast).
  - Covers: loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges.
  - Does not cover: hostile public hosts, or DNS rebinding unless the connection is pinned (C20).
- **Hosts:** the WHATWG URL parser handles scheme, case, lookalike characters (converted to punycode) and default ports.
  - Does not cover: a trailing dot (C3 rejects it) or lookalike hosts in general. That is why trust is keyed on the recipient (C2).
- **The one deliberate list:** the demo recipient set (C7). Its intent is a closed set, so a list is the correct rule there.

**2. Normalize before you compare.** Each group below must come out of one parser:
- **Amount:** challenge amount, signed amount, budget debit, verified balance change, and the amount in the memory record.
- **Recipient:** challenge recipient, transaction recipient, verified credit, memory record recipient, and the refusal lookup key.
- **Asset type:** in the challenge, in the transaction, and in the balance change.
- **Host:** seller URL host, challenge resource host, and the host shown on the question screen.
- **Owner address:** sign-in address, session principal, allowance funder, and Walrus account owner.
- **Network:** the challenge's network string and the deployment network.
- **Token hashes:** compared in constant time.

**3. Validate outputs like inputs**
- **Payment material:** decoded and re-checked against C1 before it is released (C1, C5).
- **Memory sentences:** built from canonical fields, with agent and seller text length-capped and marked as quoted (C10, C19). The next consumer is Ellai's own search and a human reading the dashboard.
- **Outcome memories:** carry the type "outcome" in Ellai's record, so they can never count as approvals (C9).
- **Reasons and MCP results:** an LLM may act on them, so they follow C17.
- **UI and /proof:** text only (C17, C18).
- **Requests to sellers:** carry only the payment header (C20).
- **Logs:** carry no bearer values (C19).

**4. Fail closed**
- What gets denied:
  - parse error, ambiguity or oversize: refuse (C3)
  - memory unavailable or unclear: ask (C12)
  - verification mismatch or timeout: pause automatic approval (C8)
  - token, session or owner lookup fails: deny
  - budget store unavailable: refuse
  - expired challenge or expired answer: refuse (C15)
- Every limit is a written number in one config file:
  - challenge size cap, purpose text length cap
  - outbound timeout and size cap, search timeout
  - distance cutoff, K
  - polling ceilings
  - refill count and refill size
  - material validity window
  - demo caps
- Safe defaults: new tokens start at the lowest limits, and the automatic-approval threshold starts at its strictest value.

**5. Name your non-goals.** Ellai does not:
- judge whether a seller is honest or delivers what it charged for
- prove that a recipient belongs to the business a host names, unless Ellai fetched the challenge itself
- cancel a payment once its material has left Ellai; expiry is the only brake
- hide memory text from the relayer operator, the embedding provider or the delegate key holder; namespace names and blob metadata are public on chain
- protect the owner from their own approvals, or from a compromised owner wallet
- keep paying when Walrus or Tatum is down; it asks or refuses instead
- cap each payment on chain. The on-chain ceiling is the float plus the allowance caps, and fixed windows let up to twice the periodic limit through across a window boundary (Sui allowance FAQ).
- stop an approved agent spending badly within its limits
- stop a replay of a landed payment's header: its bytes and signature are public on chain, so anyone can present them to the seller, a property of x402 bearer payments
- stop a caller that is not a browser with Origin checks; they stop cross-site browser requests only
- check a zkLogin proof without Tatum: sign-in and step-up trust Tatum's answer on a zkLogin signature, as every chain fact Ellai uses comes through Tatum
- survive a full server compromise beyond what the chain bounds; how much that is depends on the option (below)

## Option-sensitive risks

The three options for who signs for the purse:
- **Option 1:** Ellai alone. (Chosen.)
- **Option 2:** a multisig with agent weight 1, Ellai weight 1, owner weight 2, threshold 2.
- **Option 3:** that multisig plus an app-bound allowance through a small Ellai Move module that enforces a per-refill cap and a pause flag.

- **O1. Ellai's server is compromised.**
  - Option 1: the attacker takes every purse float plus each owner's allowance up to its periodic limit, until each owner revokes. One stolen key costs every owner.
  - Options 2 and 3: Ellai's key alone moves nothing, unless the agent key is also on the server.
  - Option 3 additionally caps each refill on chain, even if two keys fall.
- **O2. The agent is the threat.**
  - Options 1 and 2 behave the same here. A rogue agent always cosigns the payments it wants, so its signature adds nothing.
  - The multisig protects against Ellai, not against the agent. In every option, Ellai's code (C1 to C12) is the only gate against a rogue agent.
- **O3. The demo collapses to option 1.** The demo agent runs on Ellai's server with the demo agent key. In options 2 and 3 the demo purse therefore has both keys on one machine. That is fine if the demo purse is tiny and separate, but misleading if /docs presents the demo as showing multisig protection.
- **O4. Who can get the float back.**
  - Option 1: after the owner revokes, only Ellai can move the float, which makes Ellai its custodian.
  - Options 2 and 3: the owner's weight-2 key sweeps the float without Ellai.
- **O5. One purse per owner.**
  - Option 1 with a single env key invites one shared purse, which breaks C7.
  - Multisig addresses come from their member keys, so each owner gets a separate purse by design. Rotating the agent key changes the address, though, and the allowance has no update function, so each rotation means revoke and reissue.
- **O6. Who can refill.**
  - Option 1: the scheduler refills unattended. A bug or a wrong balance read refills repeatedly, up to the allowance limit (C23).
  - Option 2: a refill needs agent plus Ellai, or the owner. Unattended refills either wait for the agent or put the agent key on the server (O3).
  - Option 3: the per-refill cap and the pause flag bound such a bug on chain.
- **O7. Option 3's module brings new assets.** These are the package's upgrade authority and `SettingsPermit`. The Sui docs say: "Any holder of `SettingsPermit<A>` can rotate the spender of every allowance bound to `A`, with no funder involvement." An upgrade, or a module function that mints the permit on a weak check, could redirect every owner's allowance in one transaction. The invariants to add:
  - the module's spend can only reach the purse fixed when the allowance was issued
  - spender rotation is impossible or needs the owner's signature
  - owners can pause, and only the owner can unpause
  - upgrades are disabled, or held by a key that is not on the server
  The feature is 6.5 weeks old and its audit status is not stated (payments BRIEF 8).
- **O8. Pause.**
  - Options 1 and 2 have no pause. The only brake is revoke and reissue, and the float stays spendable after a revoke.
  - Option 3 can pause refills, but the float already in the purse stays spendable by whoever can sign for the purse.
- **O9. Signing on caller-shaped input.**
  - Option 1: a C6 bug is a direct loss.
  - Option 2: Ellai must check that the agent's partial signature covers exactly the bytes Ellai built. Otherwise a rogue agent cosigns a different transaction and Ellai combines the two.
  - In multisig options, MPP personal-message proofs also need two signers.
- **O10. Compatibility pressure.** Two things are untested: whether t2000 sellers accept a multisig sender, and whether a gasless send works from a multisig address (payments BRIEF 4). If either fails mid-build, the pull to quietly fall back to a single key is a risk to plan for now.
