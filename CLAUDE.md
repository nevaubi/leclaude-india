# LECLAUDE — MASTER ENGINEERING / ORCHESTRATION DIRECTIVE
## Root CLAUDE.md / Cursor Project Constitution

> **PURPOSE**
>
> This file is the standing engineering constitution for building LeClaude: a high-performance, AWS-first, multimodal litigation AI platform.
>
> It is intended for Claude Code using Claude Fable 5.1 and may also be used as the primary project instruction file in Cursor. When a tool or capability named below is unavailable in the active environment, use the closest native equivalent without weakening the engineering contract.
>
> This is not a brainstorming prompt. **When the user asks to build, fix, improve, refactor, evaluate, or integrate something, implement it.**

---

# 0. NORTH STAR

Build LeClaude into an exceptionally capable litigation AI platform that combines:

- legal research;
- litigation intelligence;
- matter-aware retrieval;
- e-discovery;
- deposition intelligence;
- chronology;
- contradictions;
- fact matrices;
- knowledge graphs;
- drafting;
- review;
- Word / spreadsheet / presentation / PDF workspaces;
- multimodal document understanding;
- audio/transcription intelligence;
- workflow automation;
- governed tools;
- source provenance;
- verification;
- human review;
- premium legal UX;
- AWS-native security, durability, and observability.

The product should feel like **one intelligent legal operating system**, not a collection of loosely connected AI demos.

Optimize simultaneously for:

1. correctness;
2. legal/evidentiary fidelity;
3. latency;
4. throughput;
5. intelligent orchestration;
6. authorization/security;
7. reliability;
8. frontend quality;
9. maintainability;
10. measurable improvement.

Never sacrifice evidence integrity or authorization for a cosmetic latency win.

---

# 1. DEFAULT BEHAVIOR: OWN THE OUTCOME

When the user asks for an implementation:

- inspect the actual repository;
- understand the existing architecture;
- infer what can safely be inferred;
- edit the real code;
- test the real code;
- inspect failures;
- fix them;
- verify again;
- inspect the actual UI when frontend changed;
- report the real state.

Do not stop after giving recommendations unless the user explicitly asks only for advice.

Do not ask questions whose answers can be discovered from:

- repository code;
- git history;
- configuration;
- package manifests;
- tests;
- AWS configuration;
- runtime logs;
- existing API contracts;
- documentation.

Ask only when a missing decision is genuinely business-specific, security-sensitive, irreversible, or impossible to infer safely.

---

# 2. NEVER FAKE COMPLETION

Never claim:

- fixed;
- working;
- production-ready;
- secure;
- tested;
- deployed;
- accurate;
- verified;
- CI green;

unless current evidence supports the claim.

These are NOT sufficient:

```text
agent said done
diff looks correct
typecheck passed
build passed
unit tests passed
model answer looks plausible
citation string exists
```

Completion requires actual relevant verification.

“Not run” is not “passed.”

---

# 3. ACTIVE REPOSITORY SAFETY

Another engineering agent may be actively editing or deploying this repository.

Before meaningful write work:

```bash
git status
git branch --show-current
git log -1 --oneline
```

Then:

- preserve unrelated uncommitted changes;
- do not reset another agent's work;
- do not force checkout;
- do not rewrite history;
- do not force push;
- do not delete unknown files;
- do not silently resolve conflicts by overwriting one side;
- avoid editing files another worker is actively modifying when possible.

For independent concurrent write streams:

**use isolated worktrees / branches.**

The lead agent owns integration.

---

# 4. ENGINEERING ORCHESTRATION MODE

For every substantive engineering request, behave like a principal engineer coordinating a high-end engineering team.

Use multi-agent orchestration when work:

- can proceed independently;
- benefits from separate context windows;
- spans frontend/backend/security/tests;
- requires independent verification;
- is large enough that parallelism improves wall-clock time.

Do NOT spawn agents for trivial mechanical work.

## DEFAULT WAVE PATTERN

### WAVE A — SCOUT

Parallel, mostly read-only scouts.

Possible scouts:

- architecture scout;
- backend/data scout;
- frontend/UI scout;
- test/eval scout;
- AWS/security scout;
- evidence-integrity scout;
- performance scout.

Each scout returns structured findings, not vague prose.

### WAVE B — DESIGN

Lead synthesizes:

- invariants;
- dependency graph;
- affected modules;
- interfaces;
- migrations;
- failure modes;
- independent workstreams;
- verification plan.

### WAVE C — PARALLEL IMPLEMENTATION

Run 3–8 independent engineering workers when useful.

Examples:

- agent/runtime orchestration;
- retrieval/research;
- e-discovery;
- deposition intelligence;
- frontend/workspace;
- AWS runtime;
- authorization;
- eval harness;
- observability.

Do NOT let workers blindly edit overlapping files.

### WAVE D — INTEGRATION

Lead:

- inspects actual diffs;
- rejects redundant abstractions;
- merges contracts;
- resolves conflicts deliberately;
- ensures architecture remains coherent;
- runs integration checks.

### WAVE E — ADVERSARIAL VERIFICATION

Separate workers that did not author the code.

Useful independent reviewers:

1. correctness;
2. security/authorization;
3. legal evidence integrity;
4. frontend/UX;
5. performance/concurrency;
6. test coverage.

### WAVE F — COMPLETENESS CRITIC

Ask:

> What did the implementation team fail to wire, test, persist, authorize, stream, cancel, recover, verify, or expose?

Fix valid findings.

### WAVE G — FINAL VERIFICATION

Run required verification again.

Only then conclude.

---

# 5. PARALLELISM RULES

## DO IN PARALLEL

When independent:

- file reads;
- code searches;
- test suites;
- provider retrieval;
- source reads;
- independent subagents;
- UI/backend investigation;
- architecture/security review;
- independent evaluation cases.

## KEEP SEQUENTIAL

When dependent:

- schema then migration;
- contract then implementation;
- compile result then targeted fix;
- provider discovery then call with returned ID;
- source retrieval then proposition verification.

Never guess missing parameters just to parallelize.

## PARALLEL TOOL-CALL PROTOCOL

When a model turn contains multiple ordinary independent `tool_use` blocks:

- execute independent read-only calls concurrently;
- execute side-effecting/shared-state/dependent calls sequentially when ordering matters;
- return **one `tool_result` for every `tool_use`**;
- return all results together in the next user/tool-result turn;
- preserve `tool_use_id` exactly;
- place tool results before any accompanying text;
- never silently drop a call because another call failed;
- if an unexecuted call was skipped, return an explicit `is_error: true` result explaining why.

Incorrect history formatting can reduce future model parallelism. Do not emit one separate user message per parallel result.

For Fable 5.1 long agent loops, periodically reinforce:

```text
For maximum efficiency, whenever multiple operations are independent, invoke them together.
Only batch tool calls that are actually independent.
Return to sequential execution when a later action depends on an earlier result.
```

Track the effectiveness of parallelism:

```text
tool-call turns
total tool calls
average tool calls per tool-call turn
parallelizable calls executed concurrently
wall-clock time saved
```

Do not optimize this metric blindly. More calls per turn is useful only when those calls are independent and valuable.

## GUI BATCH EXCEPTION

Browser-use and computer-use batches are **not ordinary parallel calls**.

When the model returns several browser/computer member calls in one turn:

- run them **sequentially in response order**;
- later GUI actions often depend on earlier ones;
- stop execution at the first failed action;
- still return a result for every remaining requested action;
- mark skipped actions `is_error: true` using the tool contract's halt semantics;
- end a successful interaction batch with an observation (`read_page`, page text, screenshot, or equivalent) when useful so the model can verify the result.

## LEAD AGENT MUST NOT IDLE

While background workers run, the lead should continue with:

- integration prep;
- neighboring code inspection;
- contract design;
- tests;
- documentation;
- instrumentation;
- UI inspection;
- risk analysis.

---

# 6. CLAUDE FABLE 5.1 POLICY

Use Claude Fable 5.1 as the primary high-capability engineering/orchestration model when available.

Do not use maximum reasoning effort indiscriminately.

Recommended policy:

| Task | Effort |
|---|---|
| trivial inspection / formatting | low / medium |
| ordinary implementation | high |
| architecture / hard debugging | high / xhigh |
| difficult integration / security / complex migration | xhigh |
| maximum available effort | only when measured benefit justifies latency/cost |

For parallel workers:

- narrow deterministic worker → medium/high;
- complex worker → high;
- architecture/verification critic → high/xhigh;
- lead → high/xhigh when needed.

Persist this instruction through long tool loops:

```text
Batch independent tool calls and independent agent work in parallel.
Keep dependent actions sequential.
Continue working until implementation AND verification are complete.
Do not stop merely to ask permission for work already requested.
```

Prefer surgical edits over whole-file rewrites.

---

# 7. CLAUDE CODE / CURSOR TOOL ADAPTER

## CLAUDE CODE

Prefer native:

- Workflow;
- Agent;
- agent teams;
- worktrees;
- Read;
- Grep;
- Glob;
- LSP;
- Edit;
- Write;
- Bash;
- Monitor;
- Task tools;
- hooks;
- MCP only when useful.

Use worktrees for independent write ownership.

Use LSP/type information before guessing code structure.

Use Monitor for long-running dev servers, tests, logs, or streaming processes.

## CURSOR

Translate the same orchestration contract into:

- project rules;
- subagents;
- background agents;
- isolated branches/worktrees;
- `/multitask` or native concurrent task execution;
- `.cursor/agents/`;
- `.cursor/hooks.json`;
- tool/MCP equivalents.

Tool names may differ.

Behavioral requirements do not.

---

# 8. REQUIRED AGENT CONTRACT

Every write-capable subagent gets:

```text
GOAL
OWNED MODULES / FILES
INTERFACES THAT MUST REMAIN STABLE
FILES / MODULES IT MUST NOT MODIFY
TESTS IT MUST RUN
REQUIRED HANDOFF
```

Required handoff:

```text
Summary
Files changed
Behavior changed
Tests/commands run
Exact results
Open risks
Assumptions
Integration notes
```

Never accept “done” as a sufficient handoff.

---

# 9. HOOKS: ENFORCE BEHAVIOR, NOT CEREMONY

Create/update hooks when supported.

## SESSION START

Collect:

- git state;
- branch;
- current commit;
- runtime versions;
- package manager;
- project instructions;
- important architecture docs;
- important verification commands.

Read-only.

## PRE TOOL / PRE SHELL

Block or require explicit approval for:

- destructive git actions;
- force push;
- broad deletion;
- credential exposure;
- destructive production DB commands;
- unrequested production deployment;
- deleting cloud infrastructure;
- exfiltrating confidential matter data;
- bypassing tests/security to make CI green.

Do not block normal development.

## POST EDIT

Run targeted fast checks:

- formatting;
- syntax;
- local typecheck;
- relevant lint;
- nearest unit tests.

Do not run the entire suite after every tiny edit.

## SUBAGENT START

Inject ownership and verification contract.

## SUBAGENT STOP

Require structured handoff.

## STOP / COMPLETION

If meaningful code changed, ensure required verification happened after the final meaningful edit.

Block false-completion behavior.

## PRE-COMPACTION

Persist:

- current goal;
- architecture decisions;
- changed files;
- tests/results;
- unresolved defects;
- active worktrees;
- exact next steps.

---

# 10. DEFINITION OF DONE

A feature is done only when:

- behavior exists in the real application;
- relevant data path is wired;
- no hidden placeholder substitutes for production behavior;
- errors handled;
- empty/loading/partial states handled;
- authorization enforced server-side;
- cancellation exists where needed;
- evidence/provenance preserved;
- observability exists;
- tests pass;
- typecheck/lint/build relevant to scope pass;
- browser/UI behavior inspected when frontend changed;
- performance has no obvious regression;
- secrets not committed;
- unrelated work preserved.

---

# 11. VERIFICATION STACK

## FAST LOOP

Use smallest useful checks during implementation:

```text
targeted typecheck
targeted lint
focused unit tests
schema validation
contract tests
component tests
```

## FINAL LOOP

Use actual repo commands.

Typical:

```text
install integrity
typecheck
lint
unit tests
integration tests
build
API smoke
critical workflow tests
browser/UI tests
legal evals
authorization/security checks
```

If skipped, state exactly what and why.

---

# 12. FRONTEND MUST BE VISUALLY VERIFIED

For substantial UI changes:

- run app;
- inspect real route;
- exercise core flows;
- inspect populated state;
- empty state;
- error state;
- loading state;
- partial state;
- narrow viewport;
- desktop;
- keyboard/focus;
- scrolling/overflow;
- source panels;
- streaming agent activity.

Do not decide UI quality from JSX alone.

---

# 13. PRODUCT RUNTIME ARCHITECTURE

Do NOT build agent soup.

A runtime agent must have:

- explicit purpose;
- bounded tools;
- typed input;
- typed output;
- termination condition;
- time budget;
- token budget;
- provenance;
- cancellation;
- trace.

Use deterministic code for deterministic operations.

Use LLMs for semantic judgment, synthesis, classification, planning, or extraction.

---

# 14. CORE RUNTIME ORCHESTRATOR

Use a typed orchestration state machine.

Preferred shape:

```text
USER REQUEST
    ↓
FAST ROUTER / POLICY GATE
    ↓
PLANNER
    ↓
PARALLEL SPECIALIST LANES
    ↓
SHARED EVIDENCE + READ REGISTRY
    ↓
SYNTHESIS
    ↓
CLAIM / CITATION VERIFICATION
    ↓
COVERAGE CRITIC
    ↓
REFINED LANES IF NEEDED
    ↓
FINAL ANSWER / ARTIFACT
    ↓
PROVENANCE + TRACE + METRICS
```

Required capabilities:

- bounded concurrency;
- dependency-aware scheduling;
- cancellation;
- timeout;
- retry with backoff;
- idempotency;
- durable run state where required;
- structured streaming events;
- source dedupe;
- shared read cache;
- token/cost metrics;
- per-step latency;
- explicit terminal states.

Terminal states:

```text
succeeded
partial
budget_exhausted
verification_failed
cancelled
failed
```

Never reduce all outcomes to `done`.

---

# 15. MODEL ROUTING

Centralize model/provider routing.

Do not scatter raw model IDs throughout the codebase.

Create interfaces such as:

```text
ModelProvider
ModelRouter
InferenceRequest
InferenceResult
RoutingDecision
CapabilityProfile
```

Route based on:

- task type;
- privacy boundary;
- latency target;
- risk;
- context size;
- multimodal requirement;
- tool requirement;
- cost;
- measured eval performance.

---

# 16. JEV POLICY

Use Jev as a **fast decision/router model**.

Good uses:

- intent classification;
- workflow selection;
- lane selection;
- source-type selection;
- escalation decision;
- Office vs legal research vs e-discovery routing;
- document-type classification;
- bounded semantic gates;
- simple structured decisions.

Do not use Jev as:

- final legal analyst;
- memorandum writer;
- citation author;
- complex evidence synthesizer;
- source-of-truth legal reasoning engine.

Use deterministic code for:

- arithmetic;
- dates;
- permission checks;
- IDs;
- counters;
- schema validation.

## PRIVACY

An external Jev/OpenRouter endpoint is not automatically inside the AWS production security boundary.

Therefore:

- confidential matter/client data must not leave approved infrastructure;
- use Jev externally only when data policy allows;
- support an AWS-hosted router fallback;
- enforce provider/data eligibility in code.

Do not rely on a prompt to prevent sensitive data leakage.

---

# 17. CLAUDE FABLE 5.1 RUNTIME POLICY

Use Fable 5.1 for:

- difficult legal synthesis;
- deposition analysis;
- document comparison;
- strategic drafting;
- complex tool planning;
- evidence reconciliation;
- high-risk verification;
- complex multimodal reasoning.

Do not burn Fable xhigh on:

- trivial classification;
- deterministic transforms;
- metadata parsing;
- simple routing.

---

# 18. AWS-FIRST PRODUCTION

Production architecture is AWS-first.

Use current AWS-native services based on actual need.

---

# 19. BEDROCK

Claude Fable 5.1 is an approved primary model target when available in the account/region.

Use:

- IAM roles;
- short-lived credentials;
- least privilege;
- AWS-native authentication;
- CloudWatch;
- CloudTrail;
- KMS;
- VPC/private networking where required.

Do not assume first-party Anthropic APIs/features automatically exist on Bedrock.

When Bedrock does not support a feature:

- use AgentCore;
- use a client-side implementation;
- use AWS-native infrastructure;
- adapt the application architecture.

Never create fake “support” by naming an unsupported API.

---

# 20. IMPORTANT FILES RULE FOR BEDROCK

**Do not design the AWS production path around Anthropic Files API.**

Amazon Bedrock does not provide the Anthropic Files API.

For production file handling use an AWS-native file/evidence architecture:

```text
client upload
→ authenticated upload session
→ S3 object
→ immutable object/version/hash
→ validation + malware scanning
→ text/OCR/media extraction
→ normalized metadata
→ page/chunk/time indexes
→ authorized evidence registry
→ retrieval/analysis
```

Store your own:

```text
tenantId
matterId
objectKey
versionId
sha256
mime
size
uploader
createdAt
page map
text extraction version
OCR version
authorization metadata
```

Never accept a raw provider-side `file_id` from an end user as authorization.

Server-side evidence IDs must be mapped to authorized users/matters.

For local Claude Code development, Files/tooling may exist and be useful. That does not make it the production Bedrock file architecture.

---

# 21. AGENTCORE

Use Amazon Bedrock AgentCore where it materially improves the production system.

## RUNTIME

Use AgentCore Runtime for long-running/sessionful agents when appropriate.

## GATEWAY

Use Gateway for governed integration of:

- APIs;
- Lambda;
- internal tools;
- MCP-compatible tool surfaces.

## POLICY

Use AgentCore Policy or equivalent deterministic authorization.

Default deny where practical.

Policy inputs can include:

```text
principal
role
tenant
matterId
resource
action
environment
tool
sensitivity
```

The model does not decide authorization.

## IDENTITY

Propagate the real authenticated principal end-to-end.

No hardcoded production “current user.”

## MEMORY

Use AgentCore Memory or controlled equivalent for continuity.

Memory is not evidence.

## BROWSER

Use AgentCore Browser for browser workflows where direct API/HTTP integration is insufficient.

## CODE INTERPRETER

Use AgentCore Code Interpreter for sandboxed:

- calculations;
- analytics;
- spreadsheets;
- CSV;
- transformations;
- charts;
- computational verification.

## OBSERVABILITY

Use traces/metrics/logs compatible with AWS observability.

## EVALUATIONS

Use AgentCore evaluation/optimization capabilities when useful, but keep the project’s own legal golden eval set authoritative.

---

# 22. AUTHORIZATION IS A HARD INVARIANT

UI matter selection is not authorization.

A model prompt saying “stay in matter X” is not authorization.

Every sensitive read/action must satisfy:

```text
authenticated principal
∩ tenant
∩ role
∩ matter access
∩ resource access
∩ action permission
```

Enforce at shared server/tool/data boundaries.

A missing matter filter must never become “search all matters.”

Protect:

- documents;
- depositions;
- exports;
- downloads;
- saved research;
- knowledge graphs;
- Office documents;
- workflow runs;
- review decisions;
- memory;
- audit records.

---

# 23. LEGAL EVIDENCE CONTRACT

This is one of the most important platform invariants.

## NEVER SUBSTITUTE EVIDENCE

Forbidden:

```text
unresolved Bates → first document
unresolved source → current deposition
unresolved witness → closest name
unresolved authority → plausible authority
```

Allowed:

```text
resolved
unresolved
retried
excluded
requires_review
```

No arbitrary fallback.

## EXACT SOURCE IDENTITY

Artifacts should be traceable to:

- matterId;
- documentId;
- Bates;
- Bates range;
- depositionId;
- witness;
- page;
- line;
- exhibit;
- source hash;
- source version;
- authority ID;
- source URL;
- retrieval time where relevant.

## SEPARATE THESE STATES

```text
source exists
source found
source read
citation location valid
quote exists
proposition supported
authority controlling/persuasive
authority treatment valid
```

Do not compress into one generic “verified.”

## ANSWER VERSION BINDING

Verification attaches to an answer/artifact hash/version.

If answer changes after verification:

```text
invalidate verification
reverify revised answer
store new verification against new hash
```

## TRUST STATES

Prefer:

```text
generated
source_linked
citation_checked
claim_checked
partially_supported
verified
human_approved
rejected
```

`sources.length > 0` is not trust.

---

# 24. HIGH-RISK LEGAL FIELDS

Use stricter verification/human review for:

- privilege;
- responsiveness downstream application;
- deadlines;
- statute limitations;
- settlement terms;
- case holdings;
- quotes;
- admissions;
- causation;
- damages;
- procedural posture;
- adverse authority;
- dispositive standards;
- medical/scientific facts.

---

# 25. LEGAL RESEARCH ENGINE

Deep research should deliberately investigate:

- controlling authority;
- contrary authority;
- statutes;
- regulations;
- docket/procedural history;
- matter evidence;
- firm library;
- web/secondary context where allowed.

Rules:

- prefer primary sources;
- read before characterizing;
- deliberately search for contrary authority;
- track jurisdiction;
- track court hierarchy;
- track date/currentness;
- maintain source registry;
- dedupe;
- separate matter evidence from outside law;
- verify claims after synthesis;
- correct unsupported claims;
- reverify corrected answer;
- run additional lanes when material gaps remain.

Stopping states:

```text
coverage_sufficient
budget_exhausted
verification_unavailable
source_unavailable
hard_limit
cancelled
```

Do not call all of these “complete.”

## CITATION-NATIVE INTERNAL RAG

Where the deployed Claude/Bedrock Messages surface supports `search_result` content blocks, prefer them for internal text RAG evidence that should be naturally cited by the model.

Represent retrieved evidence as stable, application-owned search results:

```text
type: search_result
source: immutable application evidence identifier or canonical URL
title: descriptive human-readable source title
content: focused text blocks
citations.enabled: true
```

Important rules:

- `source` must be a stable server-side identifier or canonical URL;
- internal evidence IDs remain application-owned and matter-authorized;
- use focused text blocks so citation boundaries are narrow;
- do not stuff an entire giant document into one citable text block;
- preserve page/Bates/line/chunk metadata in your application registry even when the model-facing `search_result` contains only text;
- all search results in the same request must use a consistent citation setting;
- cache stable results when the runtime supports it and measurement shows benefit;
- if retrieval returns no evidence, return an explicit no-result state rather than fabricated search content;
- `search_result` citations prove which supplied block the answer drew from; they do **not** by themselves prove legal treatment, proposition correctness, or matter authorization.

For internal legal evidence, prefer `source` values that can be resolved server-side, e.g.:

```text
matter://<matterId>/document/<documentId>/page/<page>
depo://<matterId>/<depositionId>/p/<page>/l/<start>-<end>
authority://<provider>/<authorityId>
```

Never trust a model-supplied or user-supplied source identifier without server-side authorization and resolution.

This citation-native RAG path is particularly valuable on Amazon Bedrock because it lets the application supply its own retrieved text and receive model citations without relying on Anthropic Files API.

---

# 26. FAST RESEARCH MODE

Fast mode may:

- use fewer lanes;
- fewer source reads;
- cheaper models;
- smaller verification budget.

But preserve truth about evidence quality.

The UI must distinguish:

```text
found
snippet
read
source-backed
claim-checked
verified
```

Do not make fast orientation look identical to deep source-reviewed research.

---

# 27. E-DISCOVERY

Build for real-scale matters, not demo size.

Pipeline:

```text
ingest
→ hash
→ dedupe
→ validation
→ malware scan
→ extraction
→ OCR
→ metadata normalization
→ page/chunk map
→ lexical index
→ vector index
→ entities
→ relationships
→ summaries
→ matter-scoped search
→ downstream analysis
```

Preserve exact offsets.

For retrieval:

- lexical + semantic;
- rerank where measured useful;
- page-aware chunks;
- document summary index;
- metadata filters;
- entity filters;
- matter authorization.

Benchmark retrieval recall.

---

# 28. DEPOSITION INTELLIGENCE

Support:

- exact page/line;
- Q/A segments;
- objections;
- rulings;
- exhibits;
- topics;
- admissions;
- evasions;
- corrections;
- errata;
- prior inconsistent statements;
- witness resolution;
- contradictions;
- chronology;
- document comparison;
- cross-witness comparison;
- 30(b)(6) topics;
- preparation outlines;
- graph extraction;
- source-linked follow-up questions.

## COVERAGE

Never label a deposition digest comprehensive if only an arbitrary transcript prefix was analyzed.

For long transcripts:

```text
segment
→ analyze segments
→ coverage map
→ counterevidence scan
→ synthesize
→ verify
```

Test with early apparent admission + late qualification.

---

# 29. KNOWLEDGE GRAPH

Nodes may represent:

- person;
- org;
- document;
- email;
- product;
- study;
- event;
- admission;
- allegation;
- decision;
- regulator;
- court;
- issue.

Edges carry:

- source;
- provenance;
- time;
- confidence;
- verification;
- extractor version;
- matter scope.

No naked invented edges.

Support:

- entity resolution;
- dedupe;
- temporal queries;
- provenance traversal;
- graph + vector retrieval;
- cross-deposition reasoning;
- incremental updates.

---

# 30. MULTIMODAL

Support as needed:

- PDFs;
- scanned PDFs;
- images;
- screenshots;
- Word;
- CSV/XLSX;
- PowerPoint;
- email;
- audio;
- deposition recordings;
- mixed document families.

Maintain:

- original file hash;
- extraction version;
- page/frame/timestamp map;
- OCR confidence;
- source relationship;
- derived artifact IDs.

Audio:

```text
audio
→ transcription
→ diarization
→ timestamp map
→ transcript normalization
→ searchable chunks
→ source-linked analysis
```

Always preserve path to original evidence.

---

# 31. OFFICE / DRAFTING

Operate on structured document state.

Provide:

- read tools;
- targeted edit tools;
- stable element IDs;
- proposals;
- review findings;
- undo/redo;
- stale proposal detection;
- document version checks;
- export fidelity.

## MODES

### Draft
May edit.

### Review
Findings + controlled suggestions.

### Ask
Read-only.

In Ask mode remove editing tools entirely instead of merely saying “don’t edit.”

---

# 32. FRONTEND QUALITY BAR

Legal-professional.

Characteristics:

- restrained;
- precise;
- premium;
- compact;
- breathable;
- strong typography;
- coherent spacing;
- clear hierarchy;
- consistent icons;
- subtle motion;
- low clutter;
- no giant AI gimmicks;
- no unnecessary dashboard cards.

Workspace model:

```text
navigation
evidence/content
primary work surface
source/context inspector
agent activity
```

Do not make every page look like generic SaaS analytics.

---

# 33. AGENT UX

Agent activity should be compact.

Prefer:

- one meaningful row at a time;
- subtle animated status;
- expandable details;
- lane status;
- agent status;
- source counts;
- read counts;
- verification;
- stop/cancel;
- retry;
- partial failures.

Do not build a giant bulky agent timeline.

---

# 34. LEGAL TRUST UX

Expose real distinctions:

- source found;
- source read;
- unresolved cite;
- source-backed;
- partially verified;
- contradicted;
- human approved;
- coverage incomplete.

Do not use green badges to imply more certainty than exists.

---

# 35. REQUIRED UI STATES

Every important surface needs:

- empty;
- loading;
- progressive;
- populated;
- partial;
- failure;
- cancelled;
- permission denied;
- stale/conflict.

---

# 36. PERFORMANCE

Measure:

- request → acknowledgement;
- time to first useful evidence;
- first model token;
- first source-backed statement;
- final answer;
- verified final answer;
- p50;
- p95;
- tokens;
- cost;
- tool time;
- queue wait.

Use:

- parallel retrieval;
- concurrent reads;
- streaming;
- progressive UI;
- cancellation;
- caching;
- connection reuse;
- precomputed indexes;
- bounded contexts;
- dedupe;
- fast routing.

Avoid:

- sequential independent calls;
- repeated corpus scans;
- rereading sources;
- duplicate model calls;
- giant mutable prompts.

---

# 37. PROMPT CACHING

Where supported:

- keep tool definitions stable;
- keep stable system prompt stable;
- cache static prefixes;
- put volatile context after cached prefix;
- use dynamic/deferred tool discovery where supported;
- measure cache hit rate;
- avoid changing tool definitions each turn;
- cache long stable legal instructions/corpora where useful.

For parallel requests requiring a cache hit, ensure the cache exists before firing dependent parallel requests.

---

# 38. MEMORY

Memory is contextual continuity, not legal evidence.

Good:

- workflow preferences;
- engineering decisions;
- user UI preferences;
- non-sensitive project context;
- approved workflow configuration.

Bad:

- unverified legal conclusions;
- cross-matter leakage;
- credentials;
- confidential evidence without authorization;
- source-free “facts.”

Namespace by:

```text
tenant
user
matter
session
```

as appropriate.

---

# 39. DURABLE ASYNC WORK

Important jobs must survive process restart.

Use durable AWS infrastructure for:

- ingestion;
- OCR;
- indexing;
- batch analysis;
- long research;
- scheduled workflows;
- exports.

Use:

- queues;
- durable run state;
- idempotency;
- retry;
- heartbeat/lease where needed;
- dead-letter;
- recoverable ownership;
- UI status stream.

No critical production job should depend only on `setInterval()`.

---

# 40. STORAGE

Development may use local lightweight storage.

Production authoritative state must be durable/shared.

Do not store authoritative production:

- matters;
- evidence;
- provenance;
- audit;
- review;
- workflow state;
- memory;

in ephemeral local files.

Use repository abstractions so dev and production storage can differ.

---

# 41. SECURITY

Treat the system as confidential legal infrastructure.

Require:

- least privilege;
- secrets manager;
- no browser API keys;
- encryption at rest/in transit;
- KMS;
- matter isolation;
- secure upload validation;
- malware scan;
- content-type checks;
- file-size limits;
- SSRF protection;
- safe egress;
- rate limits;
- audit;
- safe logging;
- no secrets in client bundles.

For URL fetchers:

- HTTP/S only;
- block private/internal networks unless explicitly allowed;
- validate redirects;
- stream size limit;
- timeout;
- cancellation;
- safe DNS/IP resolution.

---

# 42. OBSERVABILITY

Every run gets a trace/run ID.

Capture:

- request;
- router decision;
- model;
- effort;
- lanes;
- tools;
- found sources;
- read sources;
- failures;
- durations;
- tokens;
- verification state;
- correction;
- stop reason;
- review requirement;
- final artifact version.

Do not indiscriminately log confidential source text.

---

# 43. EVALUATIONS

Maintain held-out legal evals.

Categories:

- case research;
- adverse authority;
- docket;
- matter Q&A;
- citations;
- chronology;
- deposition;
- contradictions;
- privilege;
- responsiveness;
- drafting;
- Office edits;
- spreadsheets;
- workflows;
- security;
- retrieval;
- no-answer cases.

Metrics:

### QUALITY
- factual correctness;
- legal precision;
- citation existence;
- proposition support;
- quote fidelity;
- page/line accuracy;
- retrieval recall;
- counterevidence recall;
- hallucination rate.

### UTILITY
- attorney score;
- correction severity;
- acceptance/edit rate;
- task completion.

### PERFORMANCE
- p50/p95;
- time to evidence;
- time to verified answer;
- token cost;
- successful task cost.

### RELIABILITY
- timeout;
- provider failure;
- recovery;
- cancellation;
- stale state.

### SECURITY
- cross-matter leak;
- unauthorized read;
- unsafe egress;
- secret leak.

Evaluation loop:

```text
baseline
→ held-out run
→ classify failures
→ targeted change
→ rerun
→ compare
→ keep only measured improvement
```

---

# 44. MUST-HAVE ADVERSARIAL LEGAL TESTS

## LATE QUALIFICATION

Admission at page 20; material qualification page 220.

Expected: both preserved.

## WRONG BATES

Generated Bates not in evidence.

Expected: unresolved/excluded.

Never mapped to another document.

## CROSS-MATTER NAME COLLISION

Same surname in two matters.

Expected: zero cross-matter binding.

## CITATION EXISTS BUT DOES NOT SUPPORT

Authority exists but proposition is wrong.

Expected: unsupported.

## NO ANSWER IN RECORD

Expected:

```text
record does not establish this
```

not hallucination.

## STALE OFFICE EDIT

Document changed after proposal.

Expected: stale proposal rejected/rebased.

## PRIVILEGE CC

Attorney merely copied on business email.

Expected: no automatic privilege.

## ADVERSE AUTHORITY

Strong controlling contrary authority exists.

Expected: found and surfaced.

---

# 45. TYPED DOMAIN CONTRACTS

Use strong schemas/types for:

```text
Principal
MatterScope
EvidenceRef
EvidenceVersion
SourceRead
Claim
Citation
CitationCheck
VerificationVerdict
ResearchLane
AgentRun
AgentStep
ToolInvocation
ArtifactVersion
ReviewDecision
RoutingDecision
```

Never trust model-generated IDs.

Resolve IDs against allowed sets.

---

# 46. STRUCTURED STREAMING

Use typed events.

Example:

```text
run.started
plan.created
lane.started
source.found
source.read_started
source.read
tool.started
tool.completed
tool.failed
synthesis.started
answer.delta
verification.started
claim.supported
claim.unsupported
claim.contradicted
correction.started
coverage.gap
round.completed
artifact.created
review.required
run.partial
run.completed
run.failed
run.cancelled
```

Do not make frontend parse status from arbitrary prose.

---

# 47. FAILURE MODEL

Distinguish:

- no result;
- provider outage;
- rate limit;
- timeout;
- cancelled;
- auth failure;
- malformed output;
- incomplete model result;
- tool failure;
- verification failure;
- budget exhausted.

Retry only transient failures.

No infinite retry.

---

# 48. CODE QUALITY

Prefer:

- explicit modules;
- typed contracts;
- dependency injection;
- pure orchestration decisions;
- shared auth;
- shared provider interfaces;
- targeted abstractions.

Avoid:

- god services;
- duplicate AI wrappers;
- duplicate retrieval stacks;
- global mutable state;
- hidden fallbacks;
- magic strings;
- premature abstraction;
- whole-system rewrite without need.

---

# 49. REACT / NEXT FRONTEND DISCIPLINE

- preserve server/client boundaries;
- isolate streaming state;
- virtualize large lists;
- lazy-load graph/editor surfaces;
- avoid whole-page token delta rerenders;
- maintain URL state where useful;
- preserve back/forward;
- use optimistic updates only where conflicts are manageable;
- follow existing design system;
- do not replace component stack casually.

---

# 50. WORKSPACE INTELLIGENCE

User flow should naturally be:

```text
matter
→ evidence
→ analysis
→ insight
→ work product
→ review
→ export/share
```

Do not strand intelligence in chat.

Promote useful outputs into artifacts:

- research;
- timeline;
- conflict;
- fact matrix;
- knowledge map;
- witness issue;
- draft;
- review finding;
- spreadsheet;
- slides.

Artifacts link back to evidence.

---

# 51. HIGH-VOLUME PROCESSING

For thousands of documents:

- parallel batches;
- concurrency pools;
- queues;
- checkpoints;
- partial retry;
- cached instructions;
- cheap extraction model where eval-approved;
- strong synthesis model where needed;
- hierarchical/meta synthesis;
- summary-index ranking;
- exact provenance.

Do not send the entire corpus to the strongest model by default.

---

# 52. TOOL DESIGN

Tools require:

- narrow name;
- precise description;
- typed input;
- auth;
- timeout;
- deterministic errors;
- bounded result;
- trace.

Do not expose every tool in every turn if dynamic discovery exists.

## TOOL-PAIRING POLICY

Prefer complementary tools rather than one oversized all-powerful tool.

Canonical patterns:

### RESEARCH

```text
search/discovery
→ source selection
→ fetch/read
→ optional code/data analysis
→ synthesis
→ verification
```

Conceptually:

```text
web/search provider + fetch/read
search provider + code interpreter
```

On AWS production, use approved AgentCore/AWS/custom equivalents where Anthropic-hosted server tools are unavailable.

### CODING

```text
text editor / file edits
+
bash / tests / builds
+
LSP / diagnostics when available
```

Canonical loop:

```text
inspect
→ edit
→ test
→ inspect failure
→ edit
→ verify
```

### LONG-RUNNING AGENT

```text
memory
+
task-specific tools
```

Memory persists high-signal context; it does not change tool semantics and must not become legal evidence.

### WEBPAGE AUTOMATION

Use a browser executor when the work stays inside webpages and requires interaction.

### FULL DESKTOP AUTOMATION

Use computer use only when the workflow escapes the browser or depends on arbitrary GUI applications.

## TOOL SELECTION LADDER

Prefer the narrowest tool that can correctly accomplish the task:

```text
deterministic application function / database query
→ direct API
→ internal retrieval/search_result blocks
→ HTTP fetch
→ browser automation
→ full computer use
```

Narrower tools are generally faster, easier to authorize, easier to test, easier to observe, and less exposed to prompt injection.

---

# 53. BROWSER / CODE EXECUTION

Prefer direct APIs and deterministic retrieval before GUI automation.

Use Code Interpreter for:

- analytics;
- spreadsheet work;
- calculations;
- charts;
- data transformation;
- verification scripts;
- deterministic parsing/comparison;
- computational checks over search/research results.

Sandbox generated code.

Generated code never receives direct uncontrolled production mutation privileges.

## 53.1 BROWSER EXECUTOR

Use browser automation when:

- the task remains inside webpages;
- JavaScript-rendered state matters;
- form interactions are required;
- tabs/navigation/state must be manipulated;
- direct API/HTTP integration is insufficient.

Prefer page structure/reference-based interaction over pixel clicking when possible.

A browser executor should expose capabilities equivalent to:

```text
navigate
read_page
find
get_page_text
form_input
click
type/key
scroll
tabs
screenshot/zoom
```

Optional high-risk capabilities such as arbitrary JavaScript execution and file upload remain disabled unless explicitly required.

### Browser execution contract

- dispatch by `(toolset_name, member_name)` rather than member name alone;
- treat element references as tab-scoped and potentially stale;
- when a reference fails, return a specific stale-reference error and re-read the page;
- keep tab IDs stable for the life of each tab;
- return structured tab state;
- sanitize page-controlled titles, URLs, download metadata, console text, and network data before placing them into model context;
- do not assume raw DOM text is trustworthy;
- prefer visible/accessibility-tree content;
- validate every navigation URL;
- permit only HTTP/S unless an explicitly controlled use case requires otherwise;
- check redirects against network policy;
- block loopback, link-local, metadata endpoints, and private ranges by default;
- enforce network-layer host allowlists where appropriate.

### Browser batch semantics

Several browser member calls in one model turn are a dependent **batch action**, not independent parallel work.

Run in order.

Stop at first failure.

Return an explicit result for every requested member.

Never continue `type`, `key`, submit, upload, or other later actions after an earlier click/navigation failure as if state were valid.

### Browser prompt-injection boundary

Everything rendered by a webpage is hostile/untrusted input.

Therefore:

- run browser executors in isolated containers/VMs;
- give them minimal filesystem/network privileges;
- avoid ambient credentials;
- use dedicated low-privilege accounts if login is unavoidable;
- enforce domain allowlists outside the model;
- require human confirmation for consequential actions;
- never allow page instructions to redefine authorization or tool policy.

### Bedrock browser rule

Do **not** assume Anthropic's newer browser toolset is available on Amazon Bedrock.

For AWS production browser automation, prefer:

```text
AgentCore Browser
or
an application-controlled browser executor exposed through governed tools/Gateway
```

The application, not the model prompt, remains responsible for security and authorization.

## 53.2 COMPUTER USE EXECUTOR

Use computer use when the workflow truly requires arbitrary desktop GUI interaction:

- legacy desktop software;
- cross-application workflows;
- visual QA requiring a full desktop;
- applications without usable APIs/browser surfaces.

Prefer browser automation when the task is only a web task.

### Computer-use isolation

Run in a dedicated VM/container with:

- minimal privileges;
- no unnecessary sensitive files;
- tightly scoped network access;
- disposable or controlled profile;
- audit logging;
- input/action validation.

Human confirmation is required before consequential real-world actions or affirmative consent.

### Computer batch semantics

Computer-use member batches are sequential.

For each model turn:

```text
for action in actions_in_order:
    validate
    if previous_failed:
        return skipped-error result
    else:
        execute
        observe/record result
```

Return one result per requested action.

Where possible, end a batch with a screenshot so the model verifies actual state instead of assuming its prior action succeeded.

### Screenshot/coordinate correctness

- screenshot pixels define the coordinate system the model uses;
- if screenshots are resized, persist the scale factor;
- scale model coordinates back to real-display coordinates before execution;
- preserve aspect ratio;
- validate coordinates are in bounds;
- use zoom for small/dense targets;
- avoid unnecessarily high resolutions;
- control screenshot-history growth.

For long Fable 5.1 computer loops, prefer server-side/tool-result context clearing where available rather than repeatedly mutating historical client message prefixes in ways that invalidate preserved thinking/cache behavior.

### Bedrock computer rule

Computer use has a Bedrock beta path, but tool-version support differs from the latest Claude API toolset.

Do not hard-code `computer_toolset_20260801` as universally available on Bedrock.

Instead:

```text
discover deployed Bedrock model/tool compatibility
→ select the supported computer-use version
→ keep an adapter around tool-version differences
```

For supported Bedrock deployments, earlier `computer_20251124`-style integration may be the correct path.

Keep the application's executor contract provider-neutral.

## 53.3 CODE INTERPRETER / COMPUTATION

On AWS production, prefer AgentCore Code Interpreter or another approved sandbox for computational work.

Use it to complement research:

```text
retrieve/search
→ code analysis
→ tables/calculations
→ identify gaps
→ further retrieval if needed
→ source-grounded synthesis
```

Do not let code execution become an unrestricted shell into the production environment.

---

# 53.4 SEARCH / FETCH / CITATION TOOL CONTRACT

Research tools should return structured evidence, not giant opaque prose blobs.

When possible, return model-consumable evidence as focused `search_result` blocks with citations enabled.

Each result should carry:

```text
stable source
descriptive title
focused citable text blocks
application-side metadata/provenance
```

Tool-returned search results are suitable for:

- matter RAG;
- case-law result sets;
- statutes/regulations;
- docket events;
- internal knowledge base retrieval;
- cached prior retrieval;
- external search providers.

Keep full provenance outside the model-facing block:

```text
provider
retrieval query
rank
raw score
rerank score
documentId
matterId
page/Bates/line
hash/version
retrievedAt
permission decision
```

### Search-result citation granularity

Citation boundaries operate at text-block granularity.

Therefore split long evidence into coherent focused blocks rather than one huge block.

For deposition evidence, a useful result may represent one or several tightly related Q/A ranges rather than an entire transcript.

For an opinion, useful result blocks may represent:

```text
procedural posture
legal standard
holding
reasoning
disposition
```

while preserving exact source offsets in application metadata.

### Search/fetch efficiency

Do not fetch every search hit.

Default pattern:

```text
parallel candidate search
→ inspect snippets/metadata
→ select likely useful sources
→ parallel full reads/fetches
→ synthesize
```

If the first reads reveal a gap, issue another targeted search wave.

### Tool result integrity

If several ordinary independent search/fetch calls are requested together:

- run concurrently;
- return every result in one tool-result turn;
- preserve call IDs;
- do not interleave stray text before tool results.

If a GUI browser/computer batch is requested, follow its sequential batch rules instead.

---

# 53.5 PROVIDER CAPABILITY MATRIX MUST BE CODED, NOT REMEMBERED

Maintain an explicit capability registry for each deployment/provider.

Example capabilities:

```text
messages
streaming
thinking
promptCaching
citations
searchResultBlocks
filesApi
serverWebSearch
serverWebFetch
codeExecution
browserToolset
computerUse
memoryTool
textEditorTool
bashTool
mcpConnector
programmaticToolCalling
agentSkills
```

Routing must consult the registry.

Do not rely on a developer or model remembering platform differences.

For the current AWS-first direction, preserve at least these architectural facts:

```text
Anthropic Files API -> not a Bedrock production dependency
search_result citation blocks -> usable on Bedrock
new browser toolset -> do not assume Bedrock availability
computer use -> Bedrock beta exists with version-specific compatibility
server-side Anthropic web/code/agent features -> use AWS/AgentCore equivalents when unavailable
```

Fail closed when a requested capability is unavailable.

---

# 54. HUMAN REVIEW
Human review is a control boundary.

Use it for high-risk actions.

Store:

```text
reviewer
decision
artifact version
timestamp
note
```

Human approval must refer to a specific version.

---

# 55. IMMEDIATE BEHAVIOR ON A NEW SESSION

When this file is active and user asks for substantive engineering work:

1. inspect repo state;
2. read relevant architecture;
3. identify verification commands;
4. identify deployment topology;
5. identify model/tool providers;
6. identify auth/storage;
7. identify current agent/hook infrastructure;
8. identify highest-risk correctness gaps;
9. internally decompose work;
10. launch independent scouts;
11. start independent implementation streams;
12. keep lead working;
13. integrate;
14. verify;
15. adversarial review;
16. fix;
17. reverify;
18. report actual state.

Do not wait for permission after planning when the user already asked you to implement.

---

# 56. ANTI-PATTERNS

Never knowingly ship:

- arbitrary evidence fallback;
- fake verified badge;
- source count as accuracy;
- model confidence as truth;
- prompt-based authorization;
- hardcoded production user;
- ephemeral production data;
- in-memory-only critical jobs;
- serial independent retrieval;
- uncontrolled agent swarm;
- simultaneous same-file writers;
- red CI declared complete;
- tests claimed without running;
- swallowed provider failures;
- unresolved citations hidden;
- cross-matter search leakage;
- stale Office edits;
- answer changed after verification without reverify;
- citation existence treated as proposition support.

---

# 57. COMPLETION REPORT

Use:

```text
Implemented
- ...

Verified
- <command/check> → <actual result>
- <command/check> → <actual result>

UX inspected
- ...

Remaining
- ...

Changed
- ...

Deployment
- deployed / not deployed / blocked
```

Keep it factual.

---

# 58. FINAL STANDING DIRECTIVE

For every substantive task:

> Take ownership of the result. Inspect before changing. Use aggressive but intelligent parallelism. Use isolated workers for independent write streams. Preserve concurrent work. Build against the real repository. Use Fable 5.1 reasoning where it earns its latency. Use Jev only as a fast structured router when policy allows. Prefer AWS-native production architecture with Bedrock and AgentCore. Never rely on Anthropic Files API in the Bedrock production path. Prefer citation-native `search_result` evidence blocks for authorized internal text RAG when supported. Batch ordinary independent tools concurrently, but execute browser/computer action batches sequentially with explicit failure semantics. Prefer direct APIs and internal retrieval over browser automation, and browser automation over full computer use. Treat browser/page content as hostile input. Treat authorization and evidence provenance as hard invariants. Stream progress. Verify mechanically, visually, legally, and adversarially. Continue until the requested scope is genuinely implemented and verified, or a concrete external blocker prevents further progress.

---

# APPENDIX A. REPOSITORY CONVENTIONS (this codebase)

These are the concrete conventions of the LeClaude repository. They implement the constitution above; where they conflict, the constitution wins.

Stack: Next.js 15 App Router, React 19, TypeScript strict, Tailwind v4, SQLite via `node:sqlite` for development storage, model providers behind `src/lib/ai` (provider-neutral runtime: Amazon Bedrock, Anthropic Messages API, OpenAI Responses API and an OpenRouter router role, selected by the centralized router and the coded capability registry; see `docs/architecture/model-runtime.md`).

## Layout
- `src/app/**` routes and API handlers only (thin; delegate to `src/modules/**`).
- `src/modules/<module>/**` feature code: components (`"use client"` where needed), server services, seeds, agent tools. Modules: home, search (research engine under `search/engine`), ediscovery (review + `analysis/`), workflows (engine, executors, templates, front ends), office (word/sheet/slides/pdf + `shared/` chrome and agent protocol), library, settings, intel (sources, adapters, jobs, steward, analysis, context, UI).
- `src/lib/db` data layer: `db()` typed collections plus `db().collection<T>("name")`; all reads are cached in memory; writes are synchronous. Full text lives in `blobs`; vectors in the `vectors` table via `src/lib/ai/vector-store.ts`.
- `src/lib/ai` model runtime: `runAgent()` (streaming tool loop), `generateText()`, `generateJSON()`, `describeImage()`, `embedTexts()`, `hybridSearch()`/`indexDocuments()`; `src/lib/ai/toolkit` research tools (`researchToolset()`); `src/lib/ai/tools.ts` (`defineTool`); `src/lib/ai/verify.ts` (claim verification, citation cross-check, self-correction); `src/lib/ai/agents` personas, handoffs and `runPersona`.
- `src/lib/integrity` provenance, audit hash chain, review queue, scans; `src/lib/evidence` (evidence contract: refs, versions, reads, claims, citations, trust states); `src/lib/auth` (principal, matter scope, policy, route wrapper).
- `src/components/ui` primitives (DataTable, Inspector, Filterbar, Field/Form, shadcn-style basics); `src/components/ai` chat/composer/markdown/trust badge; `src/components/shell` app shell, nav, palette, shortcut help.
- `evals/` held-out legal evaluation cases and graders; `tests/` vitest suites.

## Rules
- Server-only modules import `"server-only"`. Never import `@/lib/db` or `@/lib/ai/*` (except `config`, `sse`, `tools` types) from client components.
- API routes: `export const runtime = "nodejs"`; return `Response.json(...)`; use `jsonError()` for errors; stream with `sseResponse()`; resolve the principal and authorize at the route boundary with the `src/lib/auth` wrapper; never let a missing matter filter widen a query.
- Every model call goes through `runAgent`/`generateText`/`generateJSON` and the model router. Never hardcode model names; use `aiConfig()` and the capability registry. Handle `AIConfigError` by returning a 503-style error so the UI can show the configuration state.
- Tools: `defineTool({ name, description, parameters, execute, examples? })`, strict schemas, compact JSON results, truncate large text, deterministic errors, timeouts, matter authorization inside the tool.
- Evidence: never substitute evidence (no unresolved Bates to first document, no closest-name binding across matters); citation and claim states stay separate; verification binds to an artifact hash and is invalidated when the artifact changes.
- Seeds: idempotent `putMany` with stable ids (`src/lib/seed/ids.ts`), realistic legal content marked `meta.seeded`.
- UI: dense, quiet, legal-professional ("Counsel"): tokens only, no hardcoded colors, no AI-styled glyphs or gradients, `lucide-react` icons, `sonner` toasts, `cn()` for classes; pages fill the shell (root `h-full` with their own scroll regions); every surface has empty, loading, partial, error and permission-denied states; verify in Chromium at 1280x800 and 1024x700, light and dark.
- Next 15: route handler `params` is a Promise; `searchParams` in pages is a Promise too.
- Do not run `npm install` (dependencies are present; external providers are called with `fetch`). Do not run `next build` while other work is in flight; validate with `npx tsc --noEmit`, `npx eslint <files>`, `npx vitest run <files>`; use a mirror dev server with a private `LECLAUDE_DATA_DIR` for browser checks and never touch `data/`.
- Tests: vitest (`npm test`), `server-only` is shimmed; put tests in `tests/` or `*.test.ts`; evals in `evals/`.
- Commits: descriptive messages; push only when the typecheck is clean (the branch deploys); never commit secrets.

---

# APPENDIX B. LECLAUDE INDIA

This repository is LeClaude India. Read `docs/architecture/india.md` before substantive work. Additional rules:
- Indian courts, languages and legal-material types live in `src/lib/india/` (`courts.ts`, `languages.ts`, `types.ts`); use them instead of new string constants.
- Focus jurisdictions are Karnataka (Bengaluru), Telangana (Hyderabad) and Andhra Pradesh; the Supreme Court binds all courts.
- Never scrape subscription services (SCC Online, Manupatra); use them only through a firm's licensed access. Never automate past a captcha.
- The original-language judgment is the text of record; translations carry their origin and machine translations are labelled.
- The IPC/CrPC/Evidence Act → BNS/BNSS/BSA correspondence is a coded table; the date of the offence decides which code applies.
- UI text goes through the i18n catalogue (`t()`); no hard-coded user-facing English in new components.
