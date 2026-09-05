/**
 * budget 模块出口(§3.5f 预算 ledger 与熔断)。
 */
export { BudgetLedger, DEFAULT_SOFT_RATIO } from './ledger.ts';
export type { BudgetEmitInput, BudgetLedgerOptions } from './ledger.ts';
export type { BudgetConfig, BudgetLevel, RaiseResult, RecordVerdict } from './types.ts';
