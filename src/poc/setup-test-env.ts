import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { loadConfig } from "./config.js";

const ISSUE_TEXT = `# Greet by name

Modify the Python script so that it accepts a name as a command-line argument and
prints a personalized greeting. If no name is provided, it should default to "World".

Examples:
- \`python hello.py\` → "Hello, World!"
- \`python hello.py Alice\` → "Hello, Alice!"
`;

const HELLO_PY = `print("Hello, World!")
`;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

export function setupTestEnv(workspaceRoot: string): {
  issueDir: string;
  repoPath: string;
  issueText: string;
} {
  const absRoot = resolve(workspaceRoot);
  const issueDir = join(absRoot, "test-org", "test-repo", "issue_1");
  const repoPath = join(issueDir, "repository");

  // Clean up if exists
  if (existsSync(issueDir)) {
    rmSync(issueDir, { recursive: true });
  }

  // Create issue directory (orchestrator state)
  mkdirSync(issueDir, { recursive: true });

  // Create repository directory (agent workspace)
  mkdirSync(repoPath, { recursive: true });

  // Initialize git repo with a hello world Python script
  git(["init"], repoPath);
  git(["config", "user.email", "poc@githubmate.local"], repoPath);
  git(["config", "user.name", "GitHub Mate PoC"], repoPath);

  writeFileSync(join(repoPath, "hello.py"), HELLO_PY);
  git(["add", "hello.py"], repoPath);
  git(["commit", "-m", "Initial commit: hello world"], repoPath);

  // Save the issue text in the issue directory (not inside the repo)
  writeFileSync(join(issueDir, "issue.txt"), ISSUE_TEXT);

  console.log(`Test environment created:`);
  console.log(`  Issue dir: ${issueDir}`);
  console.log(`  Repo path: ${repoPath}`);
  console.log(`  - Git repo with hello.py`);
  console.log(`  - Issue text at issue.txt`);

  return { issueDir, repoPath, issueText: ISSUE_TEXT };
}

// Run standalone if executed directly
const scriptName = process.argv[1] ?? "";
if (scriptName.endsWith("setup-test-env.ts") || scriptName.endsWith("setup-test-env.js")) {
  const config = loadConfig(process.argv[2]);
  setupTestEnv(config.workspaceRoot);
}
