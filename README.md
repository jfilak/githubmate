# GitHub Mate

A thin orchestration layer that triggers local coding agents (Claude Code, OpenCode,
or any CLI-based tool) in response to GitHub events. GitHub Mate is **not** a coding
agent — it manages git workspaces, collects and filters content from GitHub, and
launches your agent with a curated prompt.

## Why?

Several projects exist in this space, but none of them combine a minimal orchestrator,
agent-agnostic design, and a security-first approach that treats the coding agent as an
untrusted subprocess:

- **[GitHub Copilot Coding Agent](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/)**
  — First-party GitHub feature. Supports self-hosted runners. However, it locks you into
  GitHub's model (no choice of LLM), requires a Copilot Enterprise/Pro+ subscription,
  and the orchestration logic runs in GitHub's cloud — you don't control it. The agent
  has direct GitHub access with no comment filtering for prompt injection defense.

- **[sandboxed.sh](https://github.com/Th0rgal/sandboxed.sh)**
  — Self-hosted orchestrator with isolated Linux workspaces (systemd-nspawn). Agent-agnostic.
  However, it is a heavyweight platform with a web UI, MCP registry, and skill management
  system. The agent has direct GitHub access — no input filtering, no output scanning.
  Requires systemd-nspawn for isolation.

- **[Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)**
  — Agent-agnostic (Claude Code, Codex, Aider), runtime-agnostic (tmux, Docker). Manages
  parallel agent fleets. However, it is designed for multi-agent parallelism — a much
  heavier model than what GitHub Mate targets. No mention of comment filtering, output
  scanning, or restricting agent GitHub access. Agents interact with GitHub directly.

- **[Sweep AI](https://github.com/sweepai/sweep)**
  — Self-hostable via Docker. Watches issues and creates PRs. However, it requires Docker,
  is tightly coupled to OpenAI/Anthropic APIs (not agent-agnostic — it is its own agent),
  and does not support delegating to an external coding tool.

- **[OpenCode GitHub Agent](https://opencode.ai/docs/github/)**
  — Runs inside GitHub Actions runners. However, it is coupled to OpenCode as the agent
  (not agent-agnostic), runs in GitHub's infrastructure (not fully local), and the agent
  reads GitHub content directly with no input filtering.

- **[AWS remote-swe-agents](https://github.com/aws-samples/remote-swe-agents)**
  — Fully open-source, deployed on your AWS account. However, it requires AWS
  infrastructure (EC2/ECS), is tied to Bedrock models, and is not designed to run on
  a local machine with custom tools.

- **[OpenHands](https://github.com/OpenHands/OpenHands)**
  — Full AI coding agent platform with its own agent (CodeAct), Docker-based sandbox,
  web UI, and event-sourced state. Has a GitHub resolver that triggers on labeled issues.
  However, it is a heavyweight system (not a thin orchestrator), uses its own agent (not
  agent-agnostic), requires Docker, and gives the agent direct GitHub token access. Has
  had [documented prompt injection vulnerabilities](https://embracethered.com/blog/posts/2025/openhands-the-lethal-trifecta-strikes-again/)
  leading to token exfiltration. No input filtering by approved users — all comments
  reach the agent.

- **[OpenClaw](https://github.com/openclaw/openclaw)**
  — General-purpose AI assistant with a Gateway daemon, multi-channel support (Discord,
  Telegram, Slack, etc.), and a coding-agent skill. Could technically be used for this
  purpose, but it is far too heavyweight and too powerful for a focused orchestration
  task — it's an entire AI assistant platform, not a thin orchestrator. GitHub integration
  is read-only by design (cannot push code or open PRs). No input filtering or output
  scanning.

The risks of giving AI agents unfiltered access to public data are well documented.
An [OpenClaw-based agent submitted a PR to matplotlib and publicly insulted the
maintainer who rejected it](https://www.theregister.com/2026/02/12/ai_bot_developer_rejected_pull_request),
and OpenHands had [token exfiltration via prompt injection](https://embracethered.com/blog/posts/2025/openhands-the-lethal-trifecta-strikes-again/)
from content the agent read on the web. These incidents underscore why GitHub Mate
filters all input before it reaches the agent and gives the agent zero network access
or platform credentials.

GitHub Mate takes a different approach: it is a minimal, deterministic orchestrator that
treats the coding agent as an untrusted, sandboxed subprocess with no network or GitHub
access. All input is filtered (approved users only) and all output is scanned before
anything leaves the local machine.

- **Agent-agnostic** — works with any CLI-based coding agent via adapters
- **Runs on your machine** — full access to your dev tools, SDKs, databases, and custom scripts
- **No Docker or cloud required** — just a process watching GitHub and invoking your agent
- **No vendor lock-in** — bring your own model, your own agent, your own infrastructure
- **Security-first** — filtered input, sandboxed execution, scanned output, zero agent GitHub credentials

## Scope

GitHub Mate handles:

- **Listening** for GitHub events via webhook (with polling fallback): issue labels,
  submitted PR reviews, and upstream pushes (individual PR comments are ignored)
- **Git workspace management** — forking, cloning, syncing, branching
- **Fetching and filtering GitHub content** — reads issue descriptions, comments, and
  PR reviews via the GitHub API, keeping only content from approved users
  (repo admins, maintainers, or an explicit allowlist)
- **Assembling the agent prompt** — builds a complete context from the filtered content
  so the agent never needs direct GitHub access
- **Triggering** the coding agent with the assembled prompt
- **Pushing** the agent's commits and opening PRs from the fork

GitHub Mate does **not** handle:

- Code generation, review, or testing — that's the agent's job
- Deciding what to implement — it passes the filtered context through, the agent decides

The agent receives only pre-filtered content. It does not access GitHub directly,
which prevents prompt injection from untrusted commenters.

### Security: Minimal Agent Privileges

The coding agent requires only local filesystem access to the cloned workspace — it
reads files, edits code, and creates git commits. It needs **no GitHub credentials**:
no token, no `gh` auth, no GitHub MCP server. All GitHub interactions (posting comments,
pushing branches, opening PRs) are performed exclusively by the orchestrator. This
minimizes the blast radius if the agent is compromised or misbehaves.

### Security: Sandboxed Execution

The coding agent can execute arbitrary commands — that's necessary for it to do its job,
but it also means a misbehaving agent could damage the host system. The agent must run
in a sandboxed environment with filesystem access restricted to the cloned workspace.
The specific mechanism depends on the deployment environment (container, chroot,
bubblewrap, etc. — specific tooling TBD). The sandbox must:

- Restrict filesystem writes to the workspace directory only
- Prevent network access (the agent doesn't need it — no GitHub credentials)
- Isolate processes so the agent cannot signal or inspect host processes

### Security: Output Scanning

Before the orchestrator pushes code or posts comments to GitHub, all agent output is
scanned for leaked secrets using deterministic tools (regex-based scanners — specific
tooling TBD). Code changes are scanned at the commit level. Text responses (questions,
PR comments) go through the same scanning pipeline. Nothing leaves the local machine
without passing the scan. If a scan fails, the task is halted and a human is notified
via local channels (email or other — TBD). Scan failure details are recorded in local
logs only and are never posted to GitHub, to avoid exposing information that could help
attackers.

## How It Works

### Agent Communication

The orchestrator invokes the coding agent as a synchronous subprocess in headless mode
via an agent adapter. Built-in adapters are provided for Claude Code
(`claude -p "..." --output-format json`) and OpenCode (`opencode -p "..." -f json`).
Custom adapters can be added for other CLI-based agents.

The agent runs, produces a JSON response, and exits. The orchestrator never interprets
natural language — it dispatches on a structured `action` field.

The prompt instructs the agent to return JSON matching one of these actions:

```json
{ "action": "ask_question", "message": "Does this need to support Python 2?" }
```
```json
{ "action": "done", "summary": "Implemented timezone handling with DST support" }
```
```json
{ "action": "error", "message": "Cannot resolve conflicting requirements in issue" }
```

The orchestrator handles each action deterministically:

| Action         | Orchestrator response                                      |
|----------------|------------------------------------------------------------|
| `ask_question` | Posts the message as a GitHub issue/PR comment, returns to IDLE |
| `done`         | Validates that commits exist, pushes, opens/updates the PR, returns to IDLE |
| `done` (no commits) | Treated as an error — flags for human review         |
| `error`        | Logs the error, notifies a human, returns to IDLE          |

Multi-turn conversations happen via GitHub, not between the orchestrator and the agent.
If the agent asks a question, the human answers on the issue, GitHub Mate picks up the
event, and the cycle repeats with fresh context.

### Event Handling

GitHub Mate receives events via webhook (with polling as a fallback). Events do not
trigger actions directly — they are placed into a FIFO queue. The orchestrator processes
one task at a time to avoid interference between concurrent agent runs. Future versions
may introduce concurrency once the failure modes are better understood.

### State Machine

```
IDLE → (event from queue) → PROVISION_WORKSPACE → SYNC_UPSTREAM → BUILD_PROMPT
  → RUN_AGENT → CHECK_RESULT → SCAN_OUTPUT → PUSH / COMMENT → IDLE
```

The orchestrator is a fully deterministic state machine. All intelligence lives in the
coding agent; the orchestrator only manages git, filters content, and routes JSON actions.
State is persisted to disk so the orchestrator can recover after a restart.

### Upstream Change Detection

The orchestrator records the upstream HEAD commit hash for each workspace. On every
sync, if the upstream HEAD has moved, all open issues with existing workspaces are
flagged for re-analysis. The agent receives the diff and commit messages since the
last known hash as additional context so it can assess whether the upstream changes
affect its work. This is especially important because upstream changes may modify
agent instruction files (see below), which would alter the agent's behavior.

When a PR is already open, the sync step rebases the feature branch onto the updated
upstream. If the rebase succeeds, the orchestrator force-pushes the rebased branch and
proceeds with re-analysis. If the rebase fails due to conflicts, the orchestrator aborts
the rebase, posts a comment on the PR asking the human to resolve conflicts and force-push
manually, and returns to IDLE. Future versions may delegate conflict resolution to the
coding agent.

### Agent Working Directory

The coding agent is always launched with the repository root as its working directory.
This ensures the agent picks up project-specific instruction files such as `CLAUDE.md`,
`AGENTS.md`, `.opencode.json`, or similar configuration that repository maintainers
use to guide agent behavior. The orchestrator does not interpret these files — they
are the agent's responsibility.

### Plan File

The coding agent stores its implementation plan in a file in the workspace
(e.g., `.githubmate/plan.md`). This file is committed along with the code changes
and becomes visible in the PR diff. The plan file serves two purposes:

- **Continuity between runs** — the agent is stateless (fresh headless invocation each
  time), so the plan file is how it remembers its approach across the issue→PR and
  PR review cycles.
- **Reviewable artifact** — humans review the plan by commenting on the PR, not the
  issue. The issue stays clean (just the original request and clarifying questions).
  Feedback on the plan flows through the existing PR Review Loop.

The prompt instructs the agent to create or update the plan file as part of its work.
The orchestrator does not interpret the plan — it is entirely the agent's responsibility.

### Issue to PR

1. A user creates a GitHub issue with a change request.
2. A repo admin/owner labels the issue `ready-to-go`.
3. GitHub Mate provisions a workspace (or reuses an existing one):
   - forks the repo (once) and syncs the fork with upstream
   - clones locally into `<org>/<repo>/issue_<number>/` and creates a feature branch
     named after the issue number
4. GitHub Mate fetches the issue description and all comments from the GitHub API
   in chronological order, discarding any content from non-approved users.
5. GitHub Mate launches the coding agent in headless mode with the filtered context
   and instructions to create a plan file, implement the changes, and return a JSON
   response.
6. The orchestrator inspects the JSON response:
   - `done` → push the branch, open a PR from the fork to upstream (the PR
     references the issue number in its description)
   - `ask_question` → post the question as an issue comment, wait for reply
   - `error` → log and notify human

### Upstream Re-analysis

When the upstream HEAD moves after a workspace already exists for an issue:

1. GitHub Mate syncs the workspace and rebases the feature branch.
2. GitHub Mate builds a re-analysis prompt that includes:
   - the original issue description and filtered comments
   - the upstream diff and commit messages since the last known hash
   - instructions to assess whether the upstream changes affect the current work
     and, if so, adapt the implementation and commit
3. The orchestrator dispatches on the JSON response as usual (`done`, `ask_question`,
   `error`).

This is a distinct prompt from the initial implementation and PR review prompts — the
agent needs to understand it is re-evaluating existing work against upstream changes,
not starting fresh or responding to a review.

### PR Review Loop

PR reviews are the primary mechanism for communicating objections to the agent's
plan and implementation. GitHub Mate reacts only to **newly submitted reviews** (i.e., a
reviewer clicks "Submit review" with "Request changes" or "Comment"), not to individual
standalone comments or edits to previously submitted comments. This avoids overloading
the agent with partial or redundant feedback — the reviewer batches all their comments
into a single review, and the agent addresses them all at once.

The agent reads the review comments alongside its existing plan file in the workspace
and does a best-effort to address everything — updating the plan, changing the code,
or both. There is no separate re-planning phase; every review cycle is handled the
same way.

1. When a review is submitted on the PR, GitHub Mate picks up the event.
2. GitHub Mate locates the workspace via the issue number (encoded in the branch name
   and PR description), syncs with upstream, and fetches the full conversation history
   (issue comments + PR comments in chronological order), filtering out non-approved users.
3. GitHub Mate launches the agent in the existing workspace with the full filtered
   context. The agent reads its plan file from the workspace, evaluates how the new
   comments affect the plan, and does its best effort to address them — updating the
   plan file, modifying the code, or both.
4. The orchestrator inspects the JSON response:
   - `done` → push new commits (plan and/or code changes)
   - `ask_question` → post the question as a PR comment, wait for reply
   - `error` → log and notify human

## Architecture Decisions

- **Coding agent runs in tmux inside the sandbox** — each agent session is launched in
  a tmux session within the sandboxed environment so a human can enter the sandbox and
  attach to observe, debug, or intervene.
- **Agent is a synchronous subprocess** — no polling, no message queues, no file-based
  signaling. The orchestrator calls the agent, waits for JSON on stdout, and acts on it.
- **JSON contract between orchestrator and agent** — the orchestrator never parses
  natural language. Malformed JSON is treated as an error (retry once, then flag for
  human review).
- **Agent adapters** — built-in adapters for Claude Code and OpenCode translate the
  JSON contract into each agent's headless CLI interface. Custom adapters can be added
  for other tools.
- **FIFO task queue** — events are queued and processed sequentially. One agent runs at
  a time to avoid interference. Concurrency may be added in future versions.
- **Persistent state** — the orchestrator persists its state (workspace mappings, upstream
  HEAD hashes, task queue) to disk to survive restarts.
- **Workspace layout** — each issue gets a dedicated workspace at
  `<org>/<repo>/issue_<number>/`, reused across the lifecycle of that issue.
- **Platform abstraction** — the orchestrator core works with abstract concepts (issue,
  comment, merge request, repository) rather than GitHub-specific types. GitHub is the
  first and primary implementation, but the design should not prevent adding support for
  other platforms (GitLab, Jira + Git hosting, etc.) in the future. This is not a goal
  for v1 — just a constraint on the internal design to avoid unnecessary coupling.
- **Lifecycle hooks** — the orchestrator emits events at key points in the state machine,
  allowing plugins to provision or tear down external resources (e.g., start a test
  database, spin up a staging service, configure DNS). Hooks are called synchronously —
  if a hook fails, the task is halted and a human is notified. The lifecycle events are:
  - `pre_provision` — before workspace is created/synced
  - `post_provision` — workspace is ready, before prompt is built
  - `pre_agent` — prompt is assembled, before the agent is launched
  - `post_agent` — agent has finished, before output is scanned
  - `pre_publish` — output scan passed, before pushing/commenting
  - `post_publish` — commits pushed and/or comments posted
  - `on_error` — task failed at any stage
  - `on_complete` — full cycle finished (success or error), for cleanup

