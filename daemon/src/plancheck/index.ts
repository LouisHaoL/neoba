/**
 * plancheck 模块出口(§3.5c 静态校验 + §3.5g workflow check 的实现底座)。
 */
export { matchAnyCapPattern, matchCapPattern } from './match.ts';
export { IntentInvalid, WorkflowInvalid } from './errors.ts';
export { parseIntent, parseOutputBinding, parseWorkflow } from './parse.ts';
export { checkIntent, checkWorkflow } from './plancheck.ts';
export type {
  CheckResult,
  IntentConstraints,
  IntentDoc,
  Issue,
  PlanCheckContext,
  RetryTrigger,
  WorkflowDoc,
  WorkflowNodeSpec,
} from './types.ts';
