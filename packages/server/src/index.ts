export { computeCalculationAnswer, renderCalculationPrompt } from "./domain/lessons/calculation";
export * from "./config";
export { CONFIG_DEFAULTS, withConfigDefaults } from "./config-defaults";
export { createProductionSubjectRegistry } from "./domain/lessons/subjects";
export { createSubjectRegistry, type SubjectRegistry } from "./domain/lessons/registry";
export { englishGrammarSubject } from "./domain/lessons/subjects/english-grammar/module";
export { schoolSubject } from "./domain/lessons/subjects/school/module";
export { historyLikeSubject } from "./domain/lessons/testing/history-like-subject";
export { validatePool, findDuplicateAnswers, poolCoverage } from "./domain/lessons/pool-validation";
export { DEFAULT_LESSON_POLICY, defaultPoolSize } from "./domain/lessons/lesson-policy";
export type {
  SubjectModule,
  LessonTopic,
  LearningObjective,
  LessonExerciseDraft,
  LessonExerciseType,
  LessonStage,
} from "./domain/lessons/types";
export * from "./errors";
export { createDatabase, migrateDatabase, type Database } from "./db/client";
export { waitUntilDatabaseReady, type DatabaseReadinessOptions } from "./db/ready";
export * as schema from "./db/schema";
export { issueIntegrationToken, listIntegrationTokens, requireLearningReadToken, revokeIntegrationToken } from "./modules/family";
export type { IntegrationPrincipal, IntegrationTokenMetadata } from "./modules/family";
export { getLearningOverview } from "./modules/reporting";
export {
  reviewSessionActivity,
  readSessionActivityResult,
  cleanupExpiredActivityReports,
  SESSION_ACTIVITY_RETENTION_MS,
  SESSION_ACTIVITY_REVIEW_DEADLINE_MS,
  type SessionActivityErrorCode,
} from "./modules/learning";
export { readParentWorkCard } from "./modules/reporting";
export {
  isParentSetupRequired,
  setupParent,
  loginParent,
  requireParent,
  logoutParent,
  SESSION_TTL_MS,
} from "./modules/family";
export { listChildren, createChild, updateChild, deleteChild } from "./modules/family";
export { getPronunciationSettings, updatePronunciationBands } from "./modules/learning";
export {
  createEmptyDeck,
  createDraft,
  createDraftFromPublished,
  copyRevisionsSkillsAssets,
  editDraft,
  publishDraft,
  readDraft,
  readDeck,
  listDecks,
  upsertAssignment,
  removeAssignment,
  archiveDeck,
  updateDeckSettings,
  applyItems,
} from "./modules/materials";
export {
  enqueueDeckGeneration,
  executeGeneration,
  retryGeneration,
  readGeneration,
} from "./modules/materials";
export { claimQueuedRun, enqueueGenerationRun, markRun } from "./modules/materials";
export { executeMediaAsset } from "./modules/materials";
export { errorCodeOf, requireGeneration, MAX_AUTOMATIC_ATTEMPTS } from "./modules/materials";
export { countForeignPendingTts, runDueGenerationWork, type WorkerLimits } from "./modules/materials";
export {
  createLesson,
  createLessonFromMaterial,
  createSchoolLesson,
  executeLessonGeneration,
  regenerateObjective,
  regenerateLessonStory,
  applyLessonExercises,
  splitStages,
} from "./modules/materials";
export {
  lessonCatalog,
  readLessonDeck,
  editLessonDraft,
  publishLessonDraft,
  createLessonDraftFromPublished,
  deckIdOfLessonVersion,
  regenerateLessonPromptAudio,
  regenerateLessonCardAudio,
} from "./modules/materials";
export {
  lessonObjectiveProgress,
  listLessonVerdicts,
  decideLessonVerdict,
  acceptVerdictAsVariant,
} from "./modules/materials";
export {
  reconcileDraftAssets,
  regenerateRevisionAsset,
  omitRevisionAsset,
  readReadyMedia,
  readReadyMediaStream,
  type ReadyMediaStream,
} from "./modules/materials";
export { prepareUiAudio, readUiAudio, regenerateUiAudio } from "./modules/materials";
export {
  createSourceMaterial,
  updateSourceMaterial,
  deleteSourceMaterial,
  listSourceMaterials,
  getSourceMaterial,
} from "./modules/materials";
export {
  buildPayload,
  payloadToItem,
  validateItems,
} from "./modules/materials";
export { classifyRevisionImpact, buildSkillCriteria } from "./domain/revision-impact";
export { computeTargetKey, normalizeTargetText } from "./domain/target-key";
export { chooseReadingDirection, hasScheduledWork, selectTask } from "./domain/scheduler";
export { isPictureVocabularyItem, validateVocabularyFormatItems } from "./domain/picture-vocabulary";
export { getVocabularyCapabilities } from "./domain/vocabulary-capabilities";
export { buildPictureRecognitionOptions, type PictureChoiceOption, type PictureRecognitionItem } from "./domain/picture-recognition-options";
export type {
  DeckWorkloadItem,
  ScheduleCandidate,
  ScheduleInput,
  SchedulePeer,
  SkillSnapshot,
  TaskPlan,
  ScheduleReason,
  PlannedOption,
} from "./domain/scheduler";
export { readTrainingSessionPlan } from "./domain/training-session-plan";
export type { TrainingSessionPlanSnapshot, TrainingSessionSlot } from "./domain/training-session-plan";
export {
  ttsFingerprint,
  imageFingerprint,
  illustrationPrompt,
} from "./domain/media-fingerprint";
export {
  SKILLS,
  VOCABULARY_SKILLS,
  isSkill,
  isVocabularySkill,
  type Skill,
  type VocabularySkill,
  type ExerciseType,
  type PronunciationDetails,
} from "./domain/types";
export { LEARNING_V1_POLICY } from "./policies/learning-v1";
export { ensureLearningPolicy, loadPolicy, CURRENT_POLICY_ID, PolicyConfigSchema } from "./policies/registry";
export {
  startSession,
  disableSessionMicrophone,
  nextTask,
  endSession,
  completePresentation,
  DEFAULT_TASK_BUDGET,
} from "./modules/learning";
export { RESUME_WINDOW_MS, SESSION_TIME_LIMIT_MS, sessionTimeLimitMs } from "./domain/session-limits";
export { recordEvent, authorizeDisclosure, contextOf } from "./modules/learning";
export type { SessionContextShape } from "./modules/learning";
export { getMockTestReport, listMockTests, readMockTestSummary } from "./modules/learning";
export {
  getMockTestReportForSession,
  listMockTestReportsForDeck,
  readMockTestSummaryForSession,
} from "./modules/learning";
export {
  getLessonMockTestReport,
  listLessonMockTests,
  readLessonMockTestSummary,
  isLessonMockPlan,
} from "./modules/learning";

export {
  submitAttempt,
  readAttempt,
  finalizeAttempt,
  ATTEMPT_PROCESSING_TIMEOUT_MS,
} from "./modules/learning";
export { listKidProfiles, listKidDecks } from "./modules/reporting";
export { getProgress } from "./modules/reporting";
export { readSkillHistory, readSkillHistories, skillHistoryKey } from "./modules/learning";
export { persistSkillProjection } from "./modules/learning";
export { rebuildProgress, type RebuildProgressOptions, type RebuildProgressReport } from "./modules/learning";
export { evaluateWritten, evaluateChoice, evaluateNonAnswer, assessedSkills } from "./domain/evaluate";
export { chooseFeedback } from "./domain/feedback";
export { projectProgress } from "./domain/progress";
export type {
  LlmProvider,
  LlmGenerateDeckInput,
  LlmGeneratedItem,
  LessonPoolInput,
  LlmLessonObjectiveInput,
  LlmLessonTransformInput,
  LlmPromptProfileInput,
  LlmLessonStageCounts,
  TtsProvider,
  TtsSynthesizeInput,
  ImageProvider,
  ImageGenerateInput,
  AudioInput,
  TranscriptionResult,
  PronunciationResult,
  SpeechEvidence,
  SttProvider,
  PronunciationProvider,
  AnswerGraderProvider,
  GraderInput,
  SessionActivityReviewTask,
  SessionActivityReviewer,
} from "./ports/ai";
export type { MediaStore, StoredBlob, StreamedBlob } from "./ports/media";
export { createLocalMediaStore } from "./providers/media/local";
export { setDeckCover, clearDeckCover, generateDeckCover, MAX_DECK_COVER_BYTES, MAX_DECK_COVER_SAMPLE_ITEMS } from "./modules/materials";
export { createOpenAiLlmProvider } from "./providers/openai/llm";
export { createOpenAiTtsProvider } from "./providers/openai/tts";
export { createOpenAiImageProvider } from "./providers/images/openai";
export { createAzureSttProvider } from "./providers/azure/stt";
export { createAzurePronunciationProvider } from "./providers/azure/pronunciation";
export { createOpenAiCompatibleGrader } from "./providers/openai-compatible/grader";
export { createOpenAiCompatibleSessionActivityReviewer } from "./providers/openai-compatible/session-activity";
export { createOpenAiCompatibleSttProvider } from "./providers/openai-compatible/stt";
export { sessionActivityFromEnv, DEFAULT_SESSION_ACTIVITY_TIMEOUT_MS, type SessionActivityDeps } from "./config";
export {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MULTIPART_OVERHEAD_BYTES,
  normalizeAudioInput,
} from "./providers/audio/normalize";
export {
  analyzeSpeech,
  assessSpeechEvidence,
  submitSpeechAttempt,
  dictateLessonAnswer,
  MIN_STT_CONFIDENCE,
  SPEECH_ANALYSIS_TIMEOUT_MS,
  type SpeechAttemptInput,
} from "./modules/learning";
export { authorizeFeedbackAudio } from "./modules/learning";
export {
  deterministicBytes,
  fakeGenerationDeps,
  fakeMediaSettings,
  fakeSpeechDeps,
  fakeLessonSpeechDeps,
  FakeDictationSttProvider,
  fakeGraderDeps,
  fakeSessionActivityDeps,
  FakeAnswerGrader,
  FakeSessionActivityReviewer,
  type FakeSessionActivityBehavior,
  DEFAULT_FAKE_DECK_ITEMS,
  FakeImageProvider,
  FakeLlmProvider,
  FakePronunciationProvider,
  FakeSttProvider,
  FakeTtsProvider,
  type LlmBehavior,
  type LlmLessonBehavior,
  type FakeGraderBehavior,
} from "./providers/fake";
export { createGenerationDepsFromEnv, generationPublicServiceFromEnv, imageProviderFromEnv } from "./providers/generation-env";
