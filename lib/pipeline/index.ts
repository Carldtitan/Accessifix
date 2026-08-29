/**
 * The pipeline's public surface.
 *
 * Route handlers and the app pages import from here rather than reaching into
 * individual modules, so the boundary of "things the conductor owns" stays one
 * import deep.
 */
export {
  PIPELINE_STATES,
  RESUMABLE_STATES,
  STATE_ORDER,
  TERMINAL_STATES,
  IllegalTransitionError,
  RunNotFoundError,
  canTransition,
  enterState,
  failRun,
  isPipelineState,
  isTerminal,
  legalNextStates,
  loadRun,
  readState,
  requireRun,
  resumeFromPause,
  setRunPhase,
  stateRank,
  statusColumnIsLossless,
  toRunStatus,
  transition,
  type PipelineState,
  type RunState,
} from './state';

export {
  CrawlError,
  crawl,
  isSameOrigin,
  listPages,
  normaliseUrl,
  originOf,
  upsertPage,
  type CrawlOptions,
  type CrawlResult,
  type CrawledPage,
} from './crawl';

export {
  abortRun,
  activeRunIds,
  executeRun,
  isRunning,
  recordFindings,
  startRun,
  type AuditPageInput,
  type RunPipelineOptions,
} from './orchestrate';

export {
  recordBlockedCriteria,
  validateClaim,
  type FindingClaim,
  type FindingEvidence,
  type RecordFindingsInput,
  type RecordFindingsResult,
  type RejectedClaim,
} from './ledger';

export {
  loadResumeSnapshot,
  reattachSessions,
  resumeInterruptedRuns,
  resumeRun,
  runsAwaitingApproval,
  type ResumeResult,
  type ResumeSnapshot,
} from './resume';

export {
  NO_CONFORMANCE_CLAIM,
  scoreDelta,
  scoreRun,
  type CriterionScore,
  type RunDelta,
  type RunScore,
} from './score';

export {
  answerHandoff,
  awaitHandoff,
  loadHandoff,
  pendingHandoffs,
  raiseHandoff,
  type HandoffDecision,
} from './handoff';

export {
  emitEvent,
  readRunEvents,
  subscribeToRun,
  type RunEventPayload,
} from './events';

export {
  checkDeployedUrl,
  validateDeployedUrl,
  type ReachabilityResult,
} from './reachability';

export {
  currentUser,
  githubTokenForUser,
  isUuid,
  runForUser,
  targetForUser,
  type OwnedRun,
  type SignedInUser,
} from './access';

export {
  findJobByHandoff,
  listJobs,
  type JobContext,
} from './jobs';

export {
  EVENT_CAPABILITIES,
  JOB_STATUSES,
  PIPELINE_PHASES,
  pipelineJobs,
  runEvents,
  type EventCapability,
  type PipelineJob,
  type PipelinePhase,
  type RunEvent,
} from './schema';
