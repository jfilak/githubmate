import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { loadConfig } from "./config.js";
import { setupTestEnv } from "./setup-test-env.js";
import { runAgent, AgentResult } from "./agent-runner.js";
import { buildAnalyzePrompt, buildImplementPrompt } from "./prompts.js";

function saveResult(issueDir: string, phase: string, result: AgentResult): void {
  const path = join(issueDir, `${phase}-result.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`  Result saved to: ${path}`);
}

function main(): void {
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

  console.log("=== GitHub Mate PoC ===\n");
  console.log(`Agent: ${config.agent.command}`);
  console.log(`Workspace root: ${config.workspaceRoot}\n`);

  // Phase 0: Setup test environment
  console.log("--- Phase 0: Setting up test environment ---");
  const { issueDir, repoPath, issueText } = setupTestEnv(config.workspaceRoot);

  // Phase 1: Analyze the issue and create a plan
  console.log("\n--- Phase 1: Analyzing issue ---");
  const analyzePrompt = buildAnalyzePrompt(issueText);
  const analyzeResult = runAgent(issueDir, repoPath, analyzePrompt, config, "issue_analyze");

  console.log(`\n  Action: ${analyzeResult.action}`);
  saveResult(issueDir, "analyze", analyzeResult);

  if (analyzeResult.action === "ask_question") {
    console.log(`\n  Agent needs clarification: ${analyzeResult.message}`);
    console.log("  (In production, this would be posted as an issue comment)");
    console.log("  PoC stops here — answer the question and re-run.");
    return;
  }

  if (analyzeResult.action === "error") {
    console.log(`\n  Agent error: ${analyzeResult.message}`);
    return;
  }

  if (!analyzeResult.plan) {
    console.log("\n  Agent returned 'done' but no plan. Treating as error.");
    return;
  }

  // Save the plan file in the issue directory (orchestrator-owned)
  const planPath = join(issueDir, "plan.md");
  writeFileSync(planPath, analyzeResult.plan);
  console.log(`\n  Plan saved to: ${planPath}`);
  console.log(`\n  Plan:\n${analyzeResult.plan}`);

  // Copy the plan into the repo so the agent can read it during implementation
  const repoPlanDir = join(repoPath, ".githubmate");
  mkdirSync(repoPlanDir, { recursive: true });
  writeFileSync(join(repoPlanDir, "plan.md"), analyzeResult.plan);

  // Phase 2: Implement the plan
  console.log("\n--- Phase 2: Implementing plan ---");
  const planContents = readFileSync(planPath, "utf-8");
  const implementPrompt = buildImplementPrompt(planContents);
  const implementResult = runAgent(issueDir, repoPath, implementPrompt, config, "issue_implement");

  console.log(`\n  Action: ${implementResult.action}`);
  saveResult(issueDir, "implement", implementResult);

  if (implementResult.action === "done") {
    console.log(`\n  Summary: ${implementResult.summary}`);
    console.log("\n--- Verifying results ---");

    // Show git log
    const gitLog = execFileSync("git", ["log", "--oneline"], {
      cwd: repoPath,
      encoding: "utf-8",
    });
    console.log(`\n  Git log:\n${gitLog}`);

    // Show the modified file
    const helloPy = readFileSync(join(repoPath, "hello.py"), "utf-8");
    console.log(`  hello.py:\n${helloPy}`);

    // Test it
    try {
      const output1 = execFileSync("python3", ["hello.py"], {
        cwd: repoPath,
        encoding: "utf-8",
      });
      const output2 = execFileSync("python3", ["hello.py", "Alice"], {
        cwd: repoPath,
        encoding: "utf-8",
      });
      console.log(`  Test 'python3 hello.py': ${output1.trim()}`);
      console.log(`  Test 'python3 hello.py Alice': ${output2.trim()}`);
    } catch (err) {
      console.log(`  Test failed: ${err}`);
    }
  } else if (implementResult.action === "error") {
    console.log(`\n  Agent error: ${implementResult.message}`);
  }

  console.log("\n=== PoC complete ===");
}

main();
