import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { PocConfig } from "./config.js";

export interface AgentResult {
  action: "done" | "ask_question" | "error";
  plan?: string;
  summary?: string;
  message?: string;
}

function buildCommand(
  agent: PocConfig["agent"],
  prompt: string
): { command: string; args: string[] } {
  switch (agent.command) {
    case "claude":
      return {
        command: "claude",
        args: ["-p", prompt, "--output-format", "json"],
      };
    case "opencode":
      return {
        command: "opencode",
        args: ["run", "--format", "json", prompt],
      };
  }
}

function parseClaudeResponse(raw: string): string {
  // Claude Code --output-format json wraps the response in a JSON envelope.
  // The agent's text is in the "result" field.
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result !== undefined) {
      return envelope.result;
    }
  } catch {
    // Not a JSON envelope — fall through to return raw
  }
  return raw;
}

function parseOpenCodeResponse(raw: string): string {
  // OpenCode --format json outputs newline-delimited JSON events.
  // Text content is in events with "type":"text", in part.text field.
  const textParts: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return textParts.join("");
}

function extractJson(text: string): string {
  // Try to find a JSON object in the text, handling cases where the agent
  // outputs extra text before or after the JSON.
  const match = text.match(/\{[\s\S]*"action"\s*:[\s\S]*\}/);
  if (match) {
    return match[0];
  }
  return text;
}

export function runAgent(
  issueDir: string,
  repoPath: string,
  prompt: string,
  config: PocConfig,
  phase: string
): AgentResult {
  const { command, args } = buildCommand(config.agent, prompt);
  const timestamp = Math.floor(Date.now() / 1000);

  console.log(`\n--- Running agent: ${command} ---`);
  console.log(`    Repo: ${repoPath}`);

  // Save prompt before running the agent (in issue dir, outside repo)
  const promptFile = join(issueDir, `prompt_${phase}_${timestamp}.txt`);
  writeFileSync(promptFile, prompt);
  console.log(`  Prompt saved to: ${promptFile}`);

  let stdout: string;
  try {
    stdout = execFileSync(command, args, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 10 * 60 * 1000, // 10 minutes
      env: {
        ...process.env,
        // Ensure the agent doesn't try to use GitHub credentials
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
      },
    });
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string };
    if (execErr.stdout) {
      // Agent exited non-zero but produced output — try to parse it
      stdout = execErr.stdout;
    } else {
      return {
        action: "error",
        message: `Agent process failed: ${execErr.stderr || String(err)}`,
      };
    }
  }

  // Parse the response based on the agent type
  let responseText: string;
  switch (config.agent.command) {
    case "claude":
      responseText = parseClaudeResponse(stdout);
      break;
    case "opencode":
      responseText = parseOpenCodeResponse(stdout);
      break;
  }

  // Save raw response after running the agent (in issue dir, outside repo)
  const responseFile = join(issueDir, `response_${phase}_${timestamp}.txt`);
  writeFileSync(responseFile, responseText);
  console.log(`  Response saved to: ${responseFile}`);

  console.log(`\n  Agent raw text:\n${responseText.slice(0, 1000)}`);

  const jsonStr = extractJson(responseText);

  try {
    const parsed = JSON.parse(jsonStr);

    if (!parsed.action || !["done", "ask_question", "error"].includes(parsed.action)) {
      return {
        action: "error",
        message: `Invalid action in agent response: ${JSON.stringify(parsed)}`,
      };
    }

    return parsed as AgentResult;
  } catch {
    return {
      action: "error",
      message: `Failed to parse agent JSON response. Raw output:\n${responseText.slice(0, 500)}`,
    };
  }
}
