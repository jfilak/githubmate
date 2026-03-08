export function buildAnalyzePrompt(issueText: string): string {
  return `Analyze and propose a plan for the following requirements on the project in \
the current working directory. Try to minimize the scope and ask further questions only \
if the answer may dramatically affect the results. You are working in a detached \
environment and feedback will be provided for the implementation. Therefore it is \
important to propose minimal viable changes.

When you are done, print a single JSON object (and nothing else) with one of these shapes:

If you have a plan:
{"action": "done", "plan": "<your implementation plan>"}

If you cannot continue without clarification:
{"action": "ask_question", "message": "<your question>"}

If you hit an unrecoverable error:
{"action": "error", "message": "<what went wrong>"}

Here is the request:

${issueText}`;
}

export function buildImplementPrompt(planContents: string): string {
  return `You are a programmer and your task is to modify the project in the current \
working directory. You should not ask further questions — feedback will be provided on \
the result. Considering that, always do minimal changes and favor simplicity and clarity. \
Document every decision you made in code comments. Create a single commit for each \
logical step and put an explanation of why the change was done into the commit message.

When you are done with your programming task, print a single JSON object (and nothing \
else) with one of these shapes:

If you succeeded:
{"action": "done", "summary": "<comprehensive overview of changes and decisions>"}

If you cannot complete the task:
{"action": "error", "message": "<what went wrong>"}

Here is the plan:

${planContents}`;
}
