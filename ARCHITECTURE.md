# Architecture

This document describes the key software components of GitHub Mate, their
responsibilities, and how they communicate.

## Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub Mate                            │
│                                                             │
│  ┌──────────────┐    ┌──────────┐    ┌───────────────────┐  │
│  │ Event Source │───▶│  Queue   │───▶│   Orchestrator    │  │
│  │ (webhook /   │    │  (FIFO)  │    │  (state machine)  │  │
│  │  poller)     │    └──────────┘    └─────┬───┬───┬─────┘  │
│  └──────────────┘                          │   │   │        │
│                                            │   │   │        │
│  ┌──────────────┐◀─────────────────────────┘   │   │        │
│  │   Platform   │                              │   │        │
│  │   Backend    │   ┌───────────────────┐◀─────┘   │        │
│  │  (GitHub)    │   │ Workspace Manager │          │        │
│  └──────────────┘   └───────────────────┘          │        │
│                                                    │        │
│  ┌──────────────┐   ┌───────────────────┐◀─────────┘        │
│  │   Output     │◀──│  Agent Runner     │                   │
│  │   Scanner    │   │  (sandbox+tmux)   │                   │
│  └──────┬───────┘   └───────┬───────────┘                   │
│         │                   │                               │
│         │           ┌───────┴───────────┐                   │
│         │           │  Agent Adapter    │                   │
│         │           │ (claude/opencode) │                   │
│         │           └───────┬───────────┘                   │
│         │                   │                               │
└─────────┼───────────────────┼───────────────────────────────┘
          │                   │
          │          ┌────────▼────────┐
          │          │  Coding Agent   │  (untrusted, sandboxed,
          │          │  (external)     │   no network, no GitHub)
          │          └─────────────────┘
          │
     only after
     scan passes
          │
          ▼
   GitHub / GitLab / etc.
```

## Components

### 1. Event Source

**Responsibility**: Receives external events and translates them into internal
event objects.

**Inputs**:
- GitHub webhook HTTP requests (issue labeled, PR review submitted, push to
  default branch)
- GitHub API poll responses (fallback when webhook is unavailable)

**Outputs**:
- Normalized event objects placed into the Queue

**Interfaces**:
- Implements a `Platform Event Source` interface so it can be swapped for
  GitLab, Jira, etc. in the future
- Webhook mode: runs an HTTP server that receives POST requests
- Polling mode: periodically calls the Platform Backend to check for new events

**Details**:
- Events are normalized into platform-agnostic types before entering the queue:
  - `issue_ready` — an issue was labeled as ready for implementation
  - `issue_commented` — a new comment was added to a tracked issue
  - `pr_review_submitted` — a review was submitted on a tracked PR (batched
    comments from "Request changes" or "Comment" reviews)
  - `upstream_pushed` — new commits were pushed to the upstream default branch
- Individual standalone PR comments are **ignored** — only submitted reviews
  trigger the agent. Edits to previously submitted comments are also ignored.
  This prevents overloading the agent with partial, unbatched, or redundant
  feedback.
- The Event Source does not trigger any actions — it only enqueues events

---

### 2. Queue

**Responsibility**: Buffers events and ensures sequential, ordered processing.

**Inputs**:
- Normalized events from the Event Source

**Outputs**:
- Events consumed one at a time by the Orchestrator

**Details**:
- FIFO ordering
- Persisted to disk so events are not lost on restart
- Blocks new event processing until the current task completes
- Future versions may support concurrent processing with per-workspace locking

---

### 3. Orchestrator (State Machine)

**Responsibility**: The central coordinator. Consumes events from the queue,
drives the state machine, and delegates work to other components. Contains no
intelligence — all decisions are deterministic based on event type and agent
JSON responses.

**Inputs**:
- Events from the Queue
- JSON responses from the Agent Runner
- Scan results from the Output Scanner

**Outputs**:
- Commands to the Workspace Manager (provision, sync, branch)
- Commands to the Platform Backend (post comment, open PR, push)
- Commands to the Agent Runner (launch agent with prompt)
- Commands to the Output Scanner (scan commits, scan text)
- Lifecycle hook invocations to the Hook Manager

**State Machine**:

```
IDLE
  │
  ▼ (event from queue)
  │
  ▼ hook: pre_provision
PROVISION_WORKSPACE ──▶ Workspace Manager: ensure workspace exists
  │
  ▼
SYNC_UPSTREAM ──▶ Workspace Manager: sync fork, rebase feature branch
  │
  ├──(rebase conflict)──▶ Platform Backend: post comment asking human to
  │                        resolve and force-push ──▶ hook: on_complete ──▶ IDLE
  │
  ├──(HEAD moved, rebase ok, existing issue)──▶ force-push, flag for re-analysis
  │
  ▼ hook: post_provision
  │
  ▼
BUILD_PROMPT ──▶ Platform Backend: fetch & filter comments
  │               Orchestrator: select prompt type and assemble context
  │               Prompt types:
  │                 - issue_implement: initial implementation from issue
  │                 - pr_review: respond to PR review comments
  │                 - upstream_reanalyze: re-evaluate work against upstream changes
  ▼ hook: pre_agent
  │
  ▼
RUN_AGENT ──▶ Agent Runner: launch agent in sandbox with prompt
  │
  ▼ hook: post_agent
  │
  ▼
CHECK_RESULT ──▶ Parse JSON response
  │
  ├── action: "done" (with commits) ──▶ SCAN_OUTPUT
  ├── action: "done" (no commits) ──▶ ERROR
  ├── action: "ask_question" ──▶ SCAN_OUTPUT (scan the message text)
  ├── action: "error" ──▶ ERROR
  └── malformed JSON ──▶ retry once, then ERROR
  │
  ▼
SCAN_OUTPUT ──▶ Output Scanner: scan commits / text
  │
  ├── scan passed ──▶ hook: pre_publish ──▶ PUBLISH
  └── scan failed ──▶ ERROR
  │
  ▼
PUBLISH
  ├── done ──▶ Platform Backend: push commits, open/update PR
  └── ask_question ──▶ Platform Backend: post comment
  │
  ▼ hook: post_publish
  │
  ▼ hook: on_complete
IDLE

ERROR ──▶ hook: on_error ──▶ Notifier: alert human (local only), log details
      ──▶ hook: on_complete ──▶ IDLE
```

Note: all hooks are called synchronously. If a hook fails, the task is halted
and the orchestrator transitions to ERROR.

**Persisted State** (on disk):
- Current state per issue (idle, in-progress, waiting-for-answer, pr-open)
- Workspace path mapping: issue ID → filesystem path
- Upstream HEAD hash per workspace (for change detection)
- Queue contents

---

### 4. Platform Backend

**Responsibility**: All communication with the external platform (GitHub).
The only component that holds platform credentials. Provides a
platform-agnostic interface to the Orchestrator.

**Inputs**:
- Requests from the Orchestrator (fetch issue, fetch comments, post comment,
  open PR)
- Requests from the Event Source (poll for new events)

**Outputs**:
- Issue/comment/PR data (normalized into platform-agnostic types)
- Confirmation of posted comments, opened PRs

**Interface** (platform-agnostic):

```
fetch_issue(issue_id) → Issue
fetch_comments(issue_id) → [Comment]  (filtered by approved users)
fetch_pr_reviews(pr_id) → [Review]  (submitted reviews only, filtered by approved users)
post_comment(issue_or_pr_id, text)
open_pr(repo, branch, title, body)
push_branch(repo, branch)
get_upstream_head(repo) → commit_hash
```

**Details**:
- Holds the GitHub token (or GitLab token, etc.) — no other component has
  platform credentials
- Filters comments: only returns content from approved users (repo admins,
  maintainers, or explicit allowlist from configuration)
- The approved user list is part of the project configuration, not hardcoded
- First implementation: GitHub REST API
- Future implementations: GitLab API, Jira API + separate Git hosting

---

### 5. Workspace Manager

**Responsibility**: Manages the local git workspaces on the filesystem.
Handles forking, cloning, syncing, and branching.

**Inputs**:
- Commands from the Orchestrator (provision, sync, create branch, get HEAD)

**Outputs**:
- Filesystem path to the ready workspace
- Current HEAD hash (for upstream change detection)
- Diff and commit messages since a given hash (for re-analysis context)

**Interface**:

```
provision(repo, issue_id) → { issue_dir, repo_path }
  - Forks the repo (once) via Platform Backend
  - Creates <org>/<repo>/issue_<number>/ for orchestrator state
  - Clones into <org>/<repo>/issue_<number>/repository/ (or reuses existing)
  - Creates a feature branch named after the issue number

sync(workspace_path) → SyncResult { head_changed: bool, old_hash, new_hash,
                                     rebase_conflict: bool }
  - Fetches upstream and rebases the feature branch onto the updated upstream
  - If rebase conflicts occur: aborts the rebase and sets rebase_conflict=true

get_changes_since(workspace_path, since_hash) → { diff, commit_messages }
  - Returns the upstream diff and commit log for re-analysis context

has_new_commits(workspace_path) → bool
  - Checks if the agent created new commits on the feature branch

force_push(workspace_path)
  - Force-pushes the feature branch after a successful rebase
```

**Workspace Layout**:

```
<workspace_root>/
  <org>/
    <repo>/
      issue_<number>/              ← orchestrator state (issue dir)
        issue.txt                  ← fetched issue text
        plan.md                    ← agent's analysis plan
        analyze-result.json        ← agent response from analysis phase
        implement-result.json      ← agent response from implementation phase
        prompt_<phase>_<ts>.txt    ← prompt sent to the agent (audit trail)
        response_<phase>_<ts>.txt  ← raw agent response (audit trail)
        repository/                ← git repo (agent workspace)
          .git/
          .githubmate/
            plan.md                ← copy of plan for agent reference
          <project files>
```

The git repository lives in `issue_<number>/repository/`, **not** at the
issue directory root. This separation exists for two reasons:

1. **Security boundary**: The agent runs with `cwd` set to `repository/`.
   It cannot see orchestrator files (prompts, responses, issue text, result
   JSONs) one level above. Without this separation, the agent could read or
   modify orchestrator state, which could leak internal prompts or tamper with
   result parsing.

2. **Clean git state**: Orchestrator artifacts are stored outside the repo,
   so they never appear as untracked files in `git status`. The agent sees
   only project files and `.githubmate/plan.md` (intentionally placed there
   so the agent can reference the plan during implementation).

**Details**:
- Uses git CLI commands (not a git library) for simplicity and debuggability
- The workspace layout `<org>/<repo>/issue_<number>/` serves as the
  issue-to-workspace mapping — no separate database needed
- The fork is shared across issues for the same repo; each issue gets its own
  clone and branch
- On upstream changes with an open PR: rebase the feature branch. If conflicts
  arise, the orchestrator posts a comment asking the human to resolve and
  force-push. Future versions may delegate conflict resolution to the agent

---

### 6. Agent Runner

**Responsibility**: Launches the coding agent inside a sandbox and tmux session,
collects its output.

**Inputs**:
- Issue directory path (orchestrator state — for saving prompts and responses)
- Repository path (agent workspace — the git repo inside the issue directory)
- Assembled prompt (string)
- Agent adapter configuration (which agent to use)

**Outputs**:
- Raw agent output (stdout) — expected to be JSON

**Interface**:

```
run(issue_dir, repo_path, prompt, adapter) → AgentResult { stdout, exit_code }
```

**Details**:
- Saves prompt and response files to `issue_dir` (outside the repo) so the
  agent cannot access them and they don't pollute git status
- Sets the working directory to `repo_path` (the `repository/` subdirectory)
  so the agent picks up project-specific instruction files (`CLAUDE.md`,
  `AGENTS.md`, `.opencode.json`, etc.)
- Creates a sandbox environment (mechanism TBD: bubblewrap, chroot, container)
  with:
  - Filesystem: read-write access to the workspace directory only
  - Network: disabled
  - Processes: isolated from host
- Launches a tmux session inside the sandbox so humans can attach for debugging
- Delegates to the Agent Adapter to construct the actual CLI command
- Waits synchronously for the process to exit
- Captures stdout (the JSON response) and the exit code
- Enforces a configurable timeout — kills the agent if exceeded

---

### 7. Agent Adapter

**Responsibility**: Translates between the orchestrator's prompt/JSON contract
and a specific coding agent's CLI interface.

**Inputs**:
- Prompt string
- Adapter-specific configuration

**Outputs**:
- CLI command to execute (as an argument list)
- Parsed JSON response from the agent's raw stdout

**Built-in Adapters**:

| Adapter     | Command                                           | Output parsing              |
|-------------|---------------------------------------------------|-----------------------------|
| Claude Code | `claude -p "<prompt>" --output-format json`       | Extract result from JSON envelope |
| OpenCode    | `opencode -p "<prompt>" -f json -q`               | Parse JSON from stdout      |

**Interface**:

```
build_command(prompt) → [string]  (command + arguments)
parse_response(stdout) → { action, message?, summary? }
```

**Details**:
- Each adapter knows how to embed the JSON contract instructions into the
  prompt for its specific agent
- Each adapter knows how to extract the structured response from the agent's
  output format (e.g., Claude Code wraps the response in a JSON envelope)
- New adapters can be added without modifying the orchestrator

---

### 8. Output Scanner

**Responsibility**: Scans all agent output before it leaves the local machine.
Deterministic, regex-based — no LLM involved.

**Inputs**:
- Git commits (from the workspace) — scanned as diffs
- Text messages (questions, comments the agent wants to post)

**Outputs**:
- Pass/fail result
- On failure: details about what was detected (logged locally only)

**Interface**:

```
scan_commits(workspace_path) → ScanResult { passed: bool, details? }
scan_text(text) → ScanResult { passed: bool, details? }
```

**Details**:
- Scans for leaked secrets (API keys, tokens, passwords) using regex patterns
- Specific tooling TBD (candidates: gitleaks, trufflehog, detect-secrets, or
  custom regex rules)
- Scan failure details are never sent to GitHub — only stored in local logs
- Scan failure halts the task and triggers human notification

---

### 9. Hook Manager

**Responsibility**: Executes user-defined plugins at lifecycle events during
task processing. Enables provisioning and tearing down external resources
(e.g., starting a test database, spinning up a staging service, configuring
DNS) without modifying the orchestrator.

**Inputs**:
- Lifecycle event name
- Task context (issue ID, workspace path, repo, current state, agent result)

**Outputs**:
- Success/failure per hook
- On failure: the task is halted and transitions to ERROR

**Interface**:

```
run_hooks(event, context) → HookResult { passed: bool, details? }
```

**Lifecycle Events**:

| Event            | When                                                    |
|------------------|---------------------------------------------------------|
| `pre_provision`  | Before workspace is created or synced                   |
| `post_provision` | Workspace is ready, before prompt is built              |
| `pre_agent`      | Prompt is assembled, before the agent is launched       |
| `post_agent`     | Agent has finished, before output is scanned            |
| `pre_publish`    | Output scan passed, before pushing/commenting           |
| `post_publish`   | Commits pushed and/or comments posted                   |
| `on_error`       | Task failed at any stage                                |
| `on_complete`    | Full cycle finished (success or error), for cleanup     |

**Details**:
- Hooks are called synchronously — the orchestrator waits for each hook to
  complete before proceeding
- Multiple hooks can be registered per event; they run in registration order
- A hook failure at any point halts the task and triggers ERROR (except
  `on_error` and `on_complete` hooks, which log failures but don't re-trigger
  ERROR to avoid infinite loops)
- Hooks are configured per repository or globally
- Example use cases:
  - `post_provision`: start a Docker container with a test database
  - `pre_agent`: seed the database with test data
  - `on_complete`: tear down the test database container
  - `pre_publish`: run integration tests against the agent's changes

---

### 10. Notifier

**Responsibility**: Alerts a human when something requires manual intervention.

**Inputs**:
- Error events from the Orchestrator (scan failure, agent error, malformed
  JSON, done-with-no-commits)

**Outputs**:
- Notifications via local channels (email, desktop notification, or other — TBD)

**Details**:
- Never posts error details to GitHub (security constraint)
- May post a generic "task paused, human review needed" comment to GitHub
  via the Platform Backend (without specifics)
- Notification channel is configurable

---

## Communication Summary

All communication between components is **synchronous, in-process function
calls**. There are no message brokers, RPCs, or network calls between
components (except for the Platform Backend's HTTP calls to GitHub and the
Agent Runner's subprocess invocation).

```
Event Source ──(enqueue)──▶ Queue ──(dequeue)──▶ Orchestrator
                                                     │
                              ┌────────────┬─────────┼──────────┬──────────┐
                              │            │         │          │          │
                              ▼            ▼         ▼          ▼          ▼
                     Platform Backend  Workspace  Agent     Output    Hook Manager
                     (HTTP → GitHub)   Manager    Runner    Scanner   (plugins)
                                      (git→fs)  (subprocess)
                                                     │
                                                     ▼
                                               Agent Adapter
                                                     │
                                                     ▼
                                            Coding Agent (external)

                                                               Notifier (on failure)
```

**Data flow for a typical issue→PR cycle**:

1. Event Source → Queue: `issue_ready { repo: "owner/repo", issue: 123 }`
2. Queue → Orchestrator: dequeue event
3. Orchestrator → Hook Manager: `run_hooks("pre_provision", context)`
4. Orchestrator → Workspace Manager: `provision("owner/repo", 123)`
5. Orchestrator → Workspace Manager: `sync(workspace_path)`
6. Orchestrator → Hook Manager: `run_hooks("post_provision", context)`
7. Orchestrator → Platform Backend: `fetch_issue(123)`, `fetch_comments(123)`
8. Orchestrator: assembles prompt from filtered content
9. Orchestrator → Hook Manager: `run_hooks("pre_agent", context)`
10. Orchestrator → Agent Runner: `run(workspace_path, prompt, adapter)`
11. Agent Runner → Agent Adapter: `build_command(prompt)`
12. Agent Runner: creates sandbox, launches tmux, runs command, waits
13. Agent Runner → Agent Adapter: `parse_response(stdout)`
14. Agent Runner → Orchestrator: `AgentResult { action: "done", ... }`
15. Orchestrator → Hook Manager: `run_hooks("post_agent", context)`
16. Orchestrator → Workspace Manager: `has_new_commits(workspace_path)` → true
17. Orchestrator → Output Scanner: `scan_commits(workspace_path)`
18. Output Scanner → Orchestrator: `ScanResult { passed: true }`
19. Orchestrator → Hook Manager: `run_hooks("pre_publish", context)`
20. Orchestrator → Platform Backend: `push_branch(...)`, `open_pr(...)`
21. Orchestrator → Hook Manager: `run_hooks("post_publish", context)`
22. Orchestrator → Hook Manager: `run_hooks("on_complete", context)`
23. Orchestrator: persist state, return to IDLE

**Data flow for a scan failure**:

1. Steps 1–17 as above
2. Output Scanner → Orchestrator: `ScanResult { passed: false, details: "..." }`
3. Orchestrator → Hook Manager: `run_hooks("on_error", context)`
4. Orchestrator → Notifier: `alert(details)` (local only)
5. Orchestrator → Hook Manager: `run_hooks("on_complete", context)`
6. Orchestrator: persist state as error, return to IDLE
