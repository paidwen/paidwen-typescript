import type { Decision, Problem } from "./types.ts";

export class PaidwenError extends Error {
  override name = "PaidwenError";
}

export class DeniedError extends PaidwenError {
  override name = "DeniedError";
  readonly decision: Decision;

  constructor(decision: Decision) {
    super(describe(decision));
    this.decision = decision;
  }
}

export class PendingError extends PaidwenError {
  override name = "PendingError";
  readonly decision: Decision;

  constructor(decision: Decision) {
    super(describe(decision));
    this.decision = decision;
  }
}

export class RequestError extends PaidwenError {
  override name = "RequestError";
  readonly status: number;
  readonly problem: Problem | undefined;

  constructor(status: number, problem: Problem | undefined) {
    super(problem?.detail ?? problem?.title ?? `Paidwen refused the request with HTTP ${status}.`);
    this.status = status;
    this.problem = problem;
  }
}

function describe(decision: Decision): string {
  const answer = `Paidwen answered ${decision.verdict} for action ${decision.action_id}`;
  if (decision.rule_id !== null) {
    return `${answer} by rule ${decision.rule_id}.`;
  }
  if (decision.permission?.allowed === false) {
    return `${answer} because the permissions of the agent do not allow it.`;
  }
  return `${answer}.`;
}
