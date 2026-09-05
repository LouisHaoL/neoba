/**
 * modelscore 模块出口(§3.9 Model Score Registry)。
 */
export { TIERS } from './types.ts';
export type {
  AdmissionVerdict,
  AllowedModels,
  FeedbackResult,
  LoadedModelRegistry,
  ModelFeedback,
  ModelRegistryDoc,
  ModelScoreEntry,
  SampleRecord,
  ScoreDimensions,
  Tier,
  TieredMaybeScore,
  TieredSamples,
  TieredScore,
} from './types.ts';
export { ModelNotAdmitted, ModelRegistryInvalid, ModelScoreError, ModelUnknown } from './errors.ts';
export {
  EMA_ALPHA,
  checkAdmission,
  effectiveScore,
  loadModelRegistry,
  matchModelPattern,
  rankForTier,
  recordFeedback,
} from './registry.ts';
