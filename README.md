# prloop — Automated PR Review for Azure DevOps

Runs automated code review on Azure DevOps Pull Requests. Control flow lives entirely in
TypeScript: the model only "finds problems and quotes the offending code". **Line numbers,
dedup, and publish decisions are all determined by the pipeline, deterministically.**

Full design and research basis: [PROPOSAL.md](./PROPOSAL.md).

## Status

| Milestone | Scope | Status |
| --- | --- | --- |
| M1 | Direct ADO REST, local diff, quote-based line anchoring, sticky summary + inline comments | ✅ Done |
| M2 | Two-axis review: Work Item requirement check (read reqs first, then review) + code check, independent quotas, no crowding out | ✅ Done |
| M3 | Parallel multi-model finder + cross-family skeptic adversary + consensus verdict | ✅ Done |
| M4 | Rules layer + Python / Java / Next.js static analysis integration with LLM triage | ✅ Done |
| M5 | Incremental review per iteration, auto-resolve threads, dismissal logging | ✅ Done |

M1–M5 all complete. Runs end-to-end on real PRs: reads requirements first, then reviews code,
presents both axes separately, anchors comments correctly.

## Two-Axis Review

A PR can pass one axis and fail the other: follow every convention but build the wrong thing,
or build the right thing badly. Ranking both axes together makes them crowd each other out
under a comment cap — "the requirement isn't done" gets squeezed out by three critical code
findings. So prloop runs the two axes **independently, with independent quotas, in separate
summary sections**. Neither axis's models see the other's results, so one axis can never be
used to excuse the other.

- **Requirement axis**: pulls the PR's linked Work Items (walking one level up for acceptance
  criteria), and gives each criterion a verdict of
  `satisfied / missing / partial / misunderstood / not-verifiable`, plus a list of out-of-scope
  changes. The verdict describes *how it failed*, not *what percent is done* — the latter gives
  no actionable direction.
- **Code axis**: 9 finding categories × 4 severity levels. Severity comes from an ordered
  decision chain (the key split: is there a workaround?), not adjectives.

## Why Not azure-devops-mcp

Comments landing on the wrong line is structural, not a config problem: MCP is a thin wrapper
over REST — no anchor validation, no iteration bookkeeping, and older versions couldn't even
fetch file line content, so the model had to guess line numbers (see azure-devops-mcp #793,
#868). prloop talks to REST directly, and **the model's output schema has no line number field
at all**:

1. The model returns only a `quote` — a verbatim copy of the offending source.
2. The pipeline fetches the **raw bytes** of that iteration's blob by objectId (no local
   checkout, avoiding CRLF/BOM normalization differences) and searches for the quote to get an
   absolute line number.
3. When the same code appears more than once, model-supplied context disambiguates, then
   positions on changed lines win.
4. Not found or not disambiguable → **downgrade into the summary comment**. Never guess a line
   number.

Side effect: quoting code that doesn't exist = hallucination, caught automatically at this step.

## Prerequisites

- Node.js 20+ (uses built-in fetch).
- Azure DevOps auth, **pick one**:
  - **PAT**: needs **Code (Read & Write)** scope, set as `PRR_ADO_PAT`. In a pipeline you can use
    `$(System.AccessToken)` instead, but grant the Build Service Contribute to pull requests on the repo.
  - **az CLI**: skip the PAT, just `az login` — the tool takes a token from your login identity.
    Use this when org policy blocks PATs, or you don't want a PAT sitting in `.env`.
- An OpenAI-compatible model endpoint: LiteLLM proxy, vLLM, or Ollama's `/v1`.

## Install

```bash
git clone <repo> prloop && cd prloop
npm install
cp .env.example .env      # fill in PRR_ADO_PAT and PRR_LLM_BASE_URL
npm run check             # typecheck + offline selftest
```

Optional: add the wrapper to PATH.

```bash
echo 'export PATH="$PATH:'$(pwd)'/bin"' >> ~/.bashrc && source ~/.bashrc
```

## First Run

```bash
npx tsx scripts/doctor.ts '<PR URL>' --smoke   # preflight, plus one live model test
prloop '<PR URL>' --dry-run                    # compute only, no publish — check the output first
prloop '<PR URL>'                              # publish comments for real
```

PR URL format: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`.

**Run `--dry-run` first.** Confirm finding line numbers and content are right before publishing.

Exit codes: `0` no blockers on either axis, `2` unsatisfied acceptance criteria or critical/high
findings, `1` fatal error.

## Per-Run Output

`runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<timestamp>/`:

| File | Content |
| --- | --- |
| `context.json` | PR info, iteration, included and skipped file lists |
| `finder-prompt.md` | The full prompt sent to the model |
| `finder-*-raw.txt` | Raw output per model (for debugging hallucinations and format issues) |
| `requirement.json` | Requirement axis results: work items, per-criterion verdicts, out-of-scope changes |
| `static.json` / `static-findings.json` | Raw static tool results and post-triage findings |
| `skeptic.json` | Adversarial verification verdict and reasoning per finding |
| `requirement-prompt.md` / `requirement-raw.txt` | Requirement axis prompt and raw output |
| `findings.json` | Located findings: inline / below threshold / unlocatable |
| `publish.json` | Actual publish results and failure reasons |

## Settings

All environment variables, all optional. See `.env.example`. The common ones:

| Variable | Default | Description |
| --- | --- | --- |
| `PRR_ADO_PAT` | - | PAT, needs Code (Read & Write) scope. Unset → az CLI |
| `PRR_AUTH_MODE` | `auto` | `auto` (PAT if present, else az) ｜ `pat` ｜ `azcli` |
| `PRR_LLM_BASE_URL` | `http://localhost:4000/v1` | OpenAI-compatible endpoint |
| `PRR_FINDER_MODELS` | `qwen3-coder` | Comma-separated. From M3 on, use several models from different families |
| `PRR_MAX_INLINE_COMMENTS` | 10 | Inline comment cap for the code axis |
| `PRR_MAX_INLINE_REQ_COMMENTS` | 3 | Inline comment cap for the requirement axis (independent of the code axis) |
| `PRR_REQ_MODEL` | same as finder | Requirement axis model. Use a stronger model for long acceptance criteria |
| `PRR_SKIP_REQUIREMENT` | - | 1 = skip the requirement axis |
| `PRR_MIN_INLINE_SEVERITY` | `medium` | Below this severity, summary only, no inline |
| `PRR_DRY_RUN` | - | 1 = compute only, no publish |
| `PRR_POST_STATUS` | - | 1 = also report PR status (needs a branch policy to block merge) |
| `PRR_LLM_STRUCTURED` | 1 | 0 = don't send `response_format` (for backends with broken schema support) |

## Comment Behavior

- **One sticky summary**: updated in place, not a new comment on every push. Set to closed, so it
  won't trigger the "comment resolution required" policy.
- **A few inline comments**: active status, carrying `changeTrackingId` and `iterationContext`, so
  ADO tracks their position itself after new commits.
- **No duplicate comments**: each comment embeds a finding fingerprint; reruns skip anything
  already posted.
- **Clean PRs stay quiet**: nothing found → summary just says so. No noise.
- Style, naming, and formatting issues never get a comment — that's the linter's job (added in M4).

## Multi-Model Adversarial Verification

A single open-source model doing code review has a high false positive rate, so precision does not
come from "telling the model to be careful" — the finder is instead told to **report everything,
including uncertain findings** (asking a model to self-review measurably hurts recall). Filtering
happens downstream, in three independent gates:

1. **Anchoring**: quoting code that doesn't exist = hallucination, caught during the locate step.
2. **Adversarial verification (skeptic)**: each finding goes to a model from a **different family**,
   tasked with *refuting* it, not *evaluating* it. A verifier asked "is this right?" agrees; only one
   told "prove this is wrong" actually checks. The skeptic also **can't see the finder's reasoning**,
   only the claim and the code — sharing reasoning creates an anchoring effect and the verifier follows
   the original author's path instead of judging afresh.
3. **Consensus verdict**: an inline comment requires corroboration — **two models finding it
   independently**, or **surviving adversarial verification**. A finding from one model with no
   verification only appears in the summary and doesn't use comment quota.

A few deliberate asymmetries:

- The skeptic can **lower** severity, never raise it. The finder sets the ceiling; letting the
  verifier escalate would hand back exactly what it exists to counter (agreement bias).
- If the skeptic breaks or returns unparseable output, **fail open** (the finding survives). A broken
  verifier shouldn't have the power to delete real bugs; the consensus gate still demands corroboration.
- Anchoring failure is the opposite: **fail closed**. A wrong-line comment does more damage than a miss.

Enabled only when `PRR_SKEPTIC_MODELS` is set. **Use a different model family from the finder** —
a same-family verifier shares the finder's blind spots and will confirm exactly the errors you most
need caught. `doctor` checks this and warns.

## Runner

Two options:

- **`openai` (default)**: talks directly to an OpenAI-compatible endpoint (LiteLLM proxy / vLLM /
  Ollama). Supports **guided decoding**, where the inference engine enforces the schema at the token
  level — the key to weak models emitting valid JSON reliably.
- **`opencode`**: goes through the opencode CLI, reusing your existing provider config.
  **But opencode doesn't pass `response_format` to the backend**, so the schema drops from
  "engine-enforced" to "prompt-requested", and weak models comply with the format less reliably.

Before using opencode, run `npm run setup` to install the agent definition (all tools disabled —
everything the review needs is injected by prloop, and the execution environment has no target
project source to read).

```bash
npm run setup
PRR_RUNNER=opencode prloop '<PR URL>' --dry-run
```

## Static Analysis (Needs a Working Directory)

Linters need source on disk, but prloop normally reads blobs straight from Azure DevOps. So static
analysis needs `PRR_WORKDIR` pointing at a checkout of the PR source branch — in a pipeline, that's
the agent's own working directory. Unset → the whole stage is skipped, with the reason in the summary.

Tool results **go through the diff filter first** (only findings on changed lines survive), then split
three ways by tool character:

| Tier | Tools | Handling |
| --- | --- | --- |
| **Fact** | `tsc`, `mypy` | Type errors are facts. Comment directly, no model re-derivation |
| **Triage** | `bandit`, `PMD`, `SpotBugs`, `ruff`, `eslint` | Good recall, high false positives. Model decides whether it holds in actual context |
| **Suppressed** | `checkstyle`, formatting rules | Never comment, count in summary only |

The triage tier is the best empirically-supported hybrid (Semgrep false positives 560 → 64). The tool
handles recall — it never forgets a pattern; the model supplies the context pattern matching can't see:
does this value really come from outside, does an earlier check make this path unreachable, is this API
usage idiomatic in this framework.

**When `PRR_TRIAGE_MODEL` is unset, triage tier results are discarded rather than commented.** That's
deliberate fail-closed: unjudged high-false-positive output is noise.

SpotBugs needs compiled classes; no `target/classes` → skipped. Scanning stale classes reports problems
that were fixed long ago.

## Incremental Review and Comment Lifecycle

```bash
prloop '<PR URL>' --since auto    # review only commits since last time
```

`--since auto` reads the last reviewed iteration back out of our own summary comment (state lives on
the PR, not on disk — so the pipeline agent, your laptop, and a cron box don't need a shared filesystem).

Two more things happen before each publish:

- **Auto-close stale comments**: threads we posted whose target code no longer exists get marked fixed.
  The criteria are deliberately narrow — wrongly closing a live issue is worse than leaving a stale
  comment for someone to close by hand.
- **Log dismissals**: comments manually marked wontFix / byDesign get recorded. This is the raw material
  for future rule tuning — a finding category that keeps getting rejected shouldn't be reported anymore.
  For now it only logs, no action: building exclusion rules from a small sample overfits.

## Review Rules (rules/)

`rules/*.md` are directly editable review rules; each declares a glob via frontmatter `applyTo`.
**Only rules whose glob matches a changed file enter the prompt** — no Java changes means Java rules
never load, so the rule set can keep growing without blowing up every prompt.

```markdown
---
applyTo: "**/*.java"
---
# Java review rules
...
```

The built-in `_base.md` (all languages) carries the 12 code smells from chapter 3 of *Refactoring*,
bound to two constraints: the repo's own conventions always override the baseline, and every smell is
a judgment call rather than a hard violation (severity capped at medium). The second constraint is the
built-in guard against over-reporting.

`PRR_RULES_DIR` points at a rules directory elsewhere.

## Troubleshooting

**Run `npx tsx scripts/doctor.ts '<PR URL>' --smoke` first.** It names the fix for most problems.

**For certificate problems, run `tlsfix`** — it actually connects using every possible certificate
source and tells you which one works:

```bash
npx tsx scripts/tlsfix.ts '<PR URL>'
```

When you can't connect and doctor isn't clear, use **probe** to test directly:

```bash
npx tsx scripts/probe.ts '<PR URL>'
```

It unfolds what doctor hides: **where each setting actually came from** (`.env` / shell env var /
default), the full assembled URL, raw HTTP status and **the server's own error message**, and finally
tests each api-version to find which one this server accepts.

⚠️ **`.env` never overrides an existing environment variable** (so it can't clobber CI-injected values).
So if your shell has `export PRR_XXX=...`, the same key in `.env` is silently ignored. Section 1 of
probe flags this.

- **On-prem (Azure DevOps Server) won't connect.** Run `doctor <PR URL>` first — it prints the
  **API base** and the **actual request URL**. Those two lines usually show the problem. The API address
  is derived from the PR URL you gave;
  `https://tfs.corp.com/tfs/{collection}/{project}/_git/...` correctly resolves to
  `https://tfs.corp.com/tfs/{collection}` (virtual directory included). Still wrong? Override with
  `PRR_ADO_BASE_URL`.
- **On-prem reports an unsupported api-version.** Each version has a different ceiling: Server 2019 →
  `5.0`, 2020 → `6.0`, 2022 → `7.0`, cloud → `7.1`. Set `PRR_ADO_API_VERSION`.
- **`ECONNREFUSED` / connection refused.** Most often a **corporate proxy**.
  **Node's built-in `fetch` does not read `HTTP_PROXY` / `HTTPS_PROXY`** (curl, git, and pip all do,
  which is why those work and Node doesn't). prloop reads these variables itself and applies them, but
  only if they're set.

  ```bash
  export HTTPS_PROXY=http://proxy.corp:8080
  # Internal hosts (self-hosted model endpoints etc.) must bypass the proxy, or they get routed to the external egress
  export NO_PROXY=localhost,127.0.0.1,.corp.local
  ```

  **To put these in `.env`, use the `PRR_` versions**: `.env` doesn't override existing environment
  variables, so if the shell already has `HTTPS_PROXY`, the same key in `.env` neither takes effect nor
  errors. `PRR_HTTPS_PROXY` / `PRR_NO_PROXY` / `PRR_HTTP_PROXY` take priority over the conventional
  names and always work in `.env`. Section 1 of `probe` shows where each value actually came from.

  Section 1 of `probe` shows the current proxy settings; section 4 says whether the connection is direct
  or via proxy — with a proxy, TLS detection goes through a CONNECT tunnel, so a firewall rejection isn't
  misread as a certificate problem.
- **`proxy refused CONNECT: ... 403`, but git reaches the same host fine.**
  Usually **proxy filtering by User-Agent**: browsers and git allowed, unfamiliar clients blocked. It
  looks like "this host is blocked", but the host is fine — the client identity is what got rejected.

  Section 4b of `probe` tests five header combinations and tells you which one this proxy allows. prloop
  honestly sends `prloop/0.1` by default; if your proxy only allows specific strings, it's your call
  whether to play along:
  ```bash
  export PRR_USER_AGENT="git/2.34.1"
  ```
  This is a workaround for proxy policy — the proper fix is asking network admin to allowlist the tool's
  egress.

  The most useful clue is **how your git gets through**: if it can push and pull against Azure Repos, a
  working route exists. If `git config --global --get https.proxy` differs from `HTTPS_PROXY`, use that
  instead; if git has no proxy set and still works, that host should be direct — add it to `NO_PROXY`.
  A `407` means the proxy wants auth: use `http://user:password@host:port`.
- **TLS certificate errors (corporate TLS interception).** Browser opens it, tool can't connect — almost
  always this. **Node has its own built-in CA list and does not read the OS trust store** — so a
  certificate re-signed by your company's interception appliance (Zscaler, Blue Coat, etc.) is accepted
  by the browser and rejected by Node.

  The "TLS handshake" section of `npx tsx scripts/probe.ts '<PR URL>'` prints the certificate chain the
  server actually presented. If the last issuer isn't a public CA (Microsoft, DigiCert, and the like),
  it's interception, confirmed.

  **The fastest fix** is letting probe extract the certificate itself:

  ```bash
  npx tsx scripts/probe.ts '<PR URL>' --export-ca ./corporate-ca.pem
  # then put the path in .env as PRR_CA_CERTS, and run via ./bin/prloop
  ```

  On verification failure, probe writes the chain the server actually presented as PEM, saving a
  round-trip to IT for the file.
  ⚠️ This comes from the connection as it happened — don't adopt it if whoever intercepted you isn't
  someone you trust. For production use, prefer the corporate root CA from IT.

  **Simplest on Node 24+** — use the system trust store directly, no certificate file:

  ```bash
  export NODE_OPTIONS=--use-system-ca
  ```

  Version differences (all measured):

  | Node version | `--use-system-ca` | Works in `NODE_OPTIONS` |
  | --- | --- | --- |
  | 24+ | ✅ | ✅ Yes, easiest with `npx tsx` |
  | 22.15–23.x | ✅ | ❌ Not allowed, only `node --use-system-ca` directly |
  | 22.14 and below | ❌ No such flag | — |

  This flag only makes Node read the OS trust store; it **does not accept untrusted certificates**
  (measured: still rejects self-signed).

  **Full fix for a real case** (corporate TLS interception environment): the appliance presented only the
  re-signed site certificate — the intermediate was neither in the handshake nor in the system CA bundle.
  Export that intermediate from the browser: open the site → padlock in the address bar → Certificate →
  Certification Path → pick **the middle one** → export as Base64/PEM, then
  `export NODE_EXTRA_CA_CERTS=/path/to/exported.pem`.
  `tlsfix` detects automatically whether this is your case.

  **If `az` / `curl` / `git` all work on the same machine and only this tool doesn't**, the cause is
  almost certainly a different trust source: Python and curl read the CA bundle at
  `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`; Node only knows its own built-in list. Point Node at the same
  file:

  ```bash
  export NODE_EXTRA_CA_CERTS="$REQUESTS_CA_BUNDLE"   # usually /etc/ssl/certs/ca-certificates.crt
  ```

  `bin/prloop` does this automatically at startup (`NODE_EXTRA_CA_CERTS` must be set before node starts;
  the program can't change it from inside), so the wrapper needs no manual setup. Running `npx tsx`
  directly does.

  Check whether your corporate CA is in that file:
  ```bash
  awk '/BEGIN/{c=""} {c=c $0 RS} /END/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' \
    /etc/ssl/certs/ca-certificates.crt | grep -i your-company-name
  ```

  To confirm the cause you can temporarily set `NODE_TLS_REJECT_UNAUTHORIZED=0`, but **don't leave it** —
  it disables all certificate verification, which means accepting any man-in-the-middle. Switch back to
  `NODE_EXTRA_CA_CERTS` as soon as you've confirmed.
- **203 / login page error.** PAT invalid or missing scope (needs Code Read & Write). On az CLI, usually
  an expired `az login` or the wrong tenant — rerun `az login`.
- **az errors.** `doctor` shows the current auth mode and az login identity. To force one auth method,
  set `PRR_AUTH_MODE=pat` or `azcli`. az tokens are cached in-process, not fetched per request.
- **Comment landed on the wrong line.** This is the exact problem the tool exists to fix. If it still
  happens, check that finding's `anchor` in `findings.json` and compare against `finder-*-raw.txt` in
  `runs/`: if the model's quote differs from the file content (rewritten indentation or content, say),
  anchoring fails rather than misplacing. If it's genuinely misplaced, report it with that run directory.
- **Lots of findings land in "unlocatable".** Usually the model isn't copying quotes verbatim as
  instructed. First confirm `PRR_LLM_STRUCTURED=1` and that the backend really supports guided decoding;
  weak models comply with formats much less reliably without schema enforcement.
- **Model output won't parse.** The backend doesn't support `response_format`. Switch to vLLM (xgrammar
  guided decoding) or a LiteLLM proxy; or set `PRR_LLM_STRUCTURED=0` to inspect the raw output and adjust.
- **Too many comments.** Lower `PRR_MAX_INLINE_COMMENTS`, or raise `PRR_MIN_INLINE_SEVERITY` to `high`.
- **Want to block merge.** Set `PRR_POST_STATUS=1` and add a status check with genre `prloop` / name
  `ai-review` to the branch policy. Don't have a bot cast a -10 vote — it fights the reviewer policy.
- **Big PR, some files not reviewed.** The summary lists what was left out. Raise `PRR_MAX_DIFF_CHARS`
  or the model's context limit.

## Local Mode (No ADO Credentials Needed)

Builds review context from git branches — review before opening a PR, or validate the flow without ADO
access. Uses the **exact same** diff and anchoring code path.

```bash
# Generate the full prompt the finder would receive
npx tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]

# Run real anchoring and verdicts against a findings JSON, to see which line each comment lands on
npx tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json>
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run selftest    # offline tests: diff, anchoring, URL parsing, JSON parsing
npm run check       # both
npx tsx scripts/demo.ts  # render comments from fake data to see how they look (no ADO, no model calls)
```

`scripts/selftest.ts` is the regression net for line anchoring. **Always run it after changing
`libs/diff.ts` or `anchoring/locate.ts`** — its assertions map directly onto the causes of
"comment on the wrong line".

Inside it, `fixtures/seeded-pr.ts` is a real PR seeded with known defects (Python / Java / Next.js),
where every expected line number was verified against the real file with `grep -n`. It covers four
critical boundaries:

- The same line appears twice in the file and the model gave no context → **must be ruled ambiguous,
  must not guess the first one**
- Same duplicate lines but with different `context_before` → must anchor to the correct one each time
- The model quoted code that doesn't exist → must be blocked (anchoring is also the hallucination filter)
- The model rewrote the indentation → the second matching pass must still locate it

Toy fixtures (`a();`, `b();`) only prove the algorithm runs; this fixture proves it lands on the right
line in code **that looks real**.
