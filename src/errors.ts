import type { ApprovalStatus, Decision, IncidentReference, Problem } from "./types.ts";

export class PaidwenError extends Error {
  override name = "PaidwenError";
}

export class DeniedError extends PaidwenError {
  override name = "DeniedError";
  readonly decision: Decision;
  readonly approval: ApprovalStatus | undefined;
  readonly incident: IncidentReference | undefined;

  constructor(decision: Decision, approval?: ApprovalStatus) {
    super(describe(decision, approval));
    this.decision = decision;
    this.approval = approval;
    this.incident = decision.incident;
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
    super(refusal(status, problem));
    this.status = status;
    this.problem = problem;
  }
}

export function reasonOf(problem: Problem | undefined): string | undefined {
  for (const text of [problem?.detail, problem?.title]) {
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}

function refusal(status: number, problem: Problem | undefined): string {
  const reason = reasonOf(problem);
  if (status === 403) {
    return reason === undefined
      ? "Paidwen refused the agent with HTTP 403."
      : `Paidwen refused the agent: ${reason}`;
  }
  return reason ?? `Paidwen refused the request with HTTP ${status}.`;
}

function describe(decision: Decision, approval?: ApprovalStatus): string {
  const answer = `Paidwen answered ${decision.verdict} for action ${decision.action_id}`;
  if (approval?.status === "denied") {
    return `${answer}, and the approver denied it.`;
  }
  if (approval?.status === "expired") {
    return `${answer}, and the wait expired without an answer.`;
  }
  if (decision.incident) {
    const quarantine = `the agent is in quarantine (incident ${decision.incident.id})`;
    return decision.rule_id === null
      ? `${answer} because ${quarantine}.`
      : `${answer} by rule ${decision.rule_id}, and ${quarantine}.`;
  }
  if (decision.rule_id !== null) {
    return `${answer} by rule ${decision.rule_id}.`;
  }
  if (decision.budget) {
    return `${answer} because the ${decision.budget.exceeded} budget of the agent is spent.`;
  }
  if (decision.permission?.allowed === false) {
    return `${answer} because the permissions of the agent do not allow it.`;
  }
  return `${answer}.`;
}
