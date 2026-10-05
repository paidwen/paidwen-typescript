import type { components } from "./generated/api.ts";

type Schemas = components["schemas"];

export type ActionContext = Schemas["ActionContext"];
export type Approval = Schemas["Approval"];
export type Cost = Schemas["Cost"];
export type Decision = Schemas["Decision"];
export type DecisionRequest = Schemas["DecisionRequest"];
export type ObservedRule = Schemas["ObservedRule"];
export type Problem = Schemas["Problem"];
export type Tool = Schemas["Tool"];
export type ToolKind = Schemas["ToolKind"];
export type Verdict = Schemas["Verdict"];
