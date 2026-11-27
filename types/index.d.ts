export type Phase = 'idle' | 'spec' | 'build'

export type Tier = 'none' | 'low' | 'medium' | 'high'

export type LoopEvent = {
  at: number
  kind: 'deny' | 'observe' | 'verify' | 'review' | 'spec' | 'eval' | 'info'
  text: string
}

/** What an eval run switches off for its agents (ablation, C2): a rule by id, or a file or skill folder removed from the worktree. */
export type Ablation = { kind: 'rule' | 'file'; target: string }

/**
 * The eval run's live part, in the loop: the agent at work and its worktree,
 * so the guards know it. The run's progress is kept in the store
 * (`evalrun:<root>`), so an interrupted run resumes in a later session.
 */
export type EvalRun = {
  runId: string
  current: {
    id: string
    agentId: string
    dir: string
    trial: number
    pass: string
    /** When the agent started, and the session's cost estimate then (for the trial's cost, by delta). */
    startedAt: number
    startUsd: number | null
    /** The tool calls the harness saw this agent make, for the task's trajectory assertions. */
    calls: { tool: string; skill?: string; refused?: string }[]
  } | null
  without: Ablation | null
  /** How the run isolates each task: a worktree or a fresh clone. */
  isolation: 'worktree' | 'clone'
}

/** A closed spec's feature check, kept as a regression check (C2): its last result on a tree. */
export type RegressionStatus = {
  spec: string
  /** The change record it came from. */
  change: string
  check: string
  closedAt: number
  /** Null until it runs in this change; a pass covers `tree` only. */
  passes: boolean | null
  tree: string | null
}

/** One feature's standing, as the harness recorded it; features.json's `passes`, if a person wrote one, is never read or written. */
export type FeatureStatus = {
  passes: boolean
  /** The working tree the check ran on; a pass covers that tree only. */
  tree: string | null
}

/**
 * A person's one-turn exemption: a path glob, or one exact command. Bound to
 * the next main-loop turn when it starts (`turnId`), cleared when that turn ends.
 */
export type Exemption = { kind: 'path' | 'command'; value: string; turnId: string | null }

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nit'

/** Where a finding goes: the builder fixes it, a person decides it, or it waits in the backlog. */
export type Route = 'fix' | 'decision' | 'defer'

/**
 * One review finding as the harness keeps it. `open` blocks (when its
 * severity blocks at the change's tier); `closed` was addressed; `resolved`
 * a person decided; `note` could not be verified or does not block;
 * `deferred` went to the backlog.
 */
export type Finding = {
  id: string
  /** `general`, or a specialist reviewer's name. */
  reviewer: string
  severity: Severity
  file: string
  line: number
  quote: string
  problem: string
  evidence: string
  isPreExisting: boolean
  route: Route
  status: 'open' | 'closed' | 'resolved' | 'note' | 'deferred'
  /** Whether it blocks at the tier it was judged at. */
  isBlocking: boolean
  /** The round it was first reported in, and the last round that saw it. */
  round: number
  seen: number
  /** A person's note when they resolved it. */
  note: string | null
}

/** One review cycle: from its first round to a pass, the cap or a stall. */
export type ReviewCycle = {
  /** The number of the cycle's first finding id (F<from>). */
  from: number
  /** How the cycle ended; null while it goes on. */
  ended: 'pass' | 'cap' | 'stalled' | null
  /** The one summary of the cycle's end, for the person. */
  summary: string | null
  /** Rounds of this cycle whose verdict was thrown away because the tree moved while they ran (rule 11): each still counts toward the cap. */
  discarded: number
  /** The tree of this cycle's last round that settled: the next round reads the lines since it, and with none, the whole change. */
  settledTree: string | null
  /** The tree the person was last told about. */
  toldTree: string | null
  /** The line said about edits made after the cycle ended. */
  followUp: string | null
}

/** One reviewer agent of a round: the general reviewer or a specialist. */
export type ReviewAgent = {
  agentId: string
  name: string
  mode: 'general' | 'blocking' | 'shadow'
  /** Its answer had no verdict and it was asked once to restate. */
  isRetry: boolean
  /** Its answer, once in; null while it works. */
  answer: string | null
}

/** A finding left for later, kept across changes, keyed by file and quote. */
export type Deferred = {
  key: string
  file: string
  quote: string
  problem: string
  severity: Severity
  /** The spec or change it was found in, and when. */
  from: string
  at: number
  status: 'open' | 'closed'
}

/** A credential-shaped string in an added line: where, and of what kind. Never its value. */
export type CredentialHit = { file: string; line: number; kind: string }

/** What the harness proved about the tree beside the checks, and which tree it covers. */
export type Evidence = {
  tree: string | null
  credentials: CredentialHit[]
  /** Test files whose content differs from what was approved. */
  testsChanged: string[]
  /** Test files that did not exist at approval. */
  testsAdded: string[]
  /** Invisible or bidirectional-override characters in changed instruction files (C1): these keep the gate shut. */
  hidden: { file: string; line: number; kind: string }[]
}

/** What the person was shown when they approved the spec, kept on the change. */
export type Approval = {
  /** Feature checks that already passed before any implementation. */
  vacuous: string[]
  /** Feature checks that could not run at approval (not found, timed out, killed). */
  infra: string[]
  /** Check-integrity notes on the feature checks. */
  lint: string[]
  /** Numbered acceptance criteria no feature maps to. */
  unmapped: number[]
  at: number
  /**
   * The checklist items offered as candidate criteria (D2), as the person
   * approved them: kept (a feature names it), judged by a person (in the
   * report's reading aid, never in the automated gate), and struck (not
   * applicable, with a reason in SPEC.md). Absent when no checklist applied.
   */
  checklist?: { kept: string[]; person: string[]; struck: string[] }
}

/**
 * How a check ended. `not-found`, `timeout` and `killed` are infrastructure
 * outcomes: the check could not run, so no code change fixes it and no fix
 * round is spent on it.
 */
export type Outcome = 'pass' | 'fail' | 'not-found' | 'timeout' | 'killed'

/**
 * One verify check's latest run, as the loop keeps it (a different thing from
 * the command line's `CheckRun`): the tree it ran on, how it ended, when and
 * for how long. `lines` is at most the first 10 lines of the distilled output
 * (`''` on a pass); `saved` is where the whole output was kept. A run whose
 * tree changed while it ran is `isOlderTree`: it never counts for the tree now.
 */
export type CheckRecord = {
  tree: string | null
  outcome: Outcome
  at: number
  durationMs: number
  lines: string
  isOlderTree: boolean
  saved: string | null
}

/** A background check's run going now: the tree it started on, and when. */
export type BackgroundRun = { tree: string | null; startedAt: number }

/** Everything the loop knows about the change in progress, per repository. */
export type Loop = {
  /** The repository this loop belongs to; a session that moves to another root loads that root's loop. */
  root: string | null
  /** The session that last wrote it: the same id at load means a reload, not a new session. */
  sessionId: string | null
  phase: Phase
  /** The active spec's folder under specs/, or null in small-fix mode. */
  spec: string | null
  /** Hash of SPEC.md and the feature list (less `passes`) as the person approved them. */
  approvedHash: string | null
  /** Each approved feature's status, by id, in the order of the list: the only record of a pass. */
  features: Record<string, FeatureStatus>
  /** Each approved feature's dependencies, by id, as approved. */
  dependsOn: Record<string, string[]>
  /** What the approval dialog showed: vacuous checks, lint, unmapped criteria; null before approval. */
  approval: Approval | null
  /** Each test file's content hash at approval; null before approval. */
  testHashes: Record<string, string> | null
  /** Test files the builder created while building (allowed: new tests weaken nothing approved). */
  newTests: string[]
  /** Test files whose assertions dropped in an edit: a gate note each. */
  assertionDrops: string[]
  /** Exemptions a person granted that a call used: a path glob, or `command: <text>`. */
  exemptionsUsed: string[]
  /** What the harness last proved about the tree beside the checks. */
  evidence: Evidence
  /** The working tree's content hash as last read; null outside git. */
  tree: string | null
  /** True when the last snapshot said the folder is not a git work tree (not merely that no snapshot could be read). */
  isOutsideGit?: boolean
  /** Whether the snapshot could find the base branch; false shuts the gate. */
  isBaseKnown: boolean
  /** A file changed since verification last passed. */
  isDirty: boolean
  /** Repository-relative paths that differ from the base, newest last; never capped. */
  changed: string[]
  hasTouchedTests: boolean
  tier: Tier
  /** The diff against the base: files, and lines added plus removed. */
  size: { files: number; lines: number }
  verify: {
    /** `error`: the harness itself failed while verifying; the gate stays shut and a person is told. */
    status: 'none' | 'pass' | 'fail' | 'error'
    /** Fix rounds the stop gate has spent since the person's last prompt. */
    rounds: number
    failed: string | null
    at: number
    /** The working tree the last run covered, as a content hash; null outside git. */
    tree: string | null
    /** Which checks the last run covered: `full` includes the fast ones. */
    profile: 'none' | 'fast' | 'full'
    /** The last failure's fingerprint, so the same failure twice in a row is named. */
    fingerprint: string | null
    /** Each check's last pass, by command: the tree it passed on, for the flake check. */
    passedOn: Record<string, string>
    /**
     * Each check with `when` globs, by command: the key of the content of the
     * files its globs matched when it last passed (DESIGN 4.16). Under
     * `testing.scope: "targeted"` a pass carries to a tree whose covered
     * files have the same key.
     */
    covered: Record<string, string>
    /** The tree of the last stop the gate blocked: a stop on the same tree means no progress. */
    blockedTree: string | null
    /** How the last failing check ended when it could not run at all (not found, timed out, killed); null for a real failure. */
    infra: string | null
    /**
     * Each check's latest run, by command, foreground and background alike.
     * A background check that could not run on a tree (not found, killed)
     * says so here by its `outcome`, and is not started again on that tree.
     */
    runs: Record<string, CheckRecord>
  }
  /** Background checks running now, by command: the tree each started on, and when. */
  background: Record<string, BackgroundRun>
  review: {
    status: 'none' | 'running' | 'pass' | 'fail'
    round: number
    agentId: string | null
    isAuto: boolean
    summary: string | null
    at: number
    /** The working tree the round started on: a verdict covers that tree only. */
    tree: string | null
    /** Every reviewer agent of the round in progress (the general one and specialists). */
    agents: ReviewAgent[]
    /** Rounds in a row that closed no open finding. */
    stalled: number
    /** Two stalled rounds ended the review loop: a person reads the change. */
    isStalled: boolean
    /**
     * A round failed and its findings went to the builder: the next stop that
     * verifies a moved tree starts the next round by itself, in every phase (C1, 11a).
     */
    isLooping: boolean
    /** The round in progress reads only the lines changed since the last round (DESIGN 4.16, decision 8); absent or false: the whole change. */
    isScoped?: boolean
    /**
     * The review cycle this round belongs to (agent-driven review, rules 5,
     * 11, 13-15): `maxReviewRounds` bounds one cycle, which ends with a pass,
     * the cap or a stall; the next ready moment after a pass starts a new one
     * at round 1.
     */
    cycle: ReviewCycle
  }
  /** Every finding of this change's review rounds, with its status. */
  findings: Finding[]
  /** What the person exempted from the guards, until the turn it is bound to ends. */
  allow: Exemption[]
  /** The last refusal's rule and how many came in a row, this turn. */
  refusals: { rule: string; count: number }
  /** The builder said it is blocked (devloop_blocked): the stop gate lets it stop. Cleared by the person's next prompt. */
  blocked: { reason: string; at: number } | null
  /** A budget the person set for this session, over the config's. */
  budgetUsd: number | null
  isOverBudget: boolean
  /** The commit the last closed change ended on: later diffs start there. */
  base: string | null
  events: LoopEvent[]
  evalRun: EvalRun | null
  /**
   * Instruction files git ignores, by path, with their content hash when the
   * change began: one that differs now counts as changed (C1, nanochat note 1).
   * Null until the first snapshot of the change.
   */
  ignoredBase: Record<string, string> | null
  /** The regression checks of closed specs (C2), by id, with their last result in this change. */
  regressions: Record<string, RegressionStatus>
  /** Counts for the change record (C2): when the change began, fix rounds spent across prompts. */
  tally: { startedAt: number | null; fixRounds: number }
  /** Files the builder's own edit tools or shell commands wrote in this change (the report's disclosure). */
  agentWritten: string[]
  /** The `.tasks` task this session held when the spec was started (D2): the change record and the report cite it. */
  task: string | null
  /**
   * Promoted checklist items whose latest result failed (D2), with the tree
   * it failed on: each is a gate row of its own on that tree. Shadow items
   * never appear here.
   */
  checklistFails: { ref: string; note: string; tree: string | null }[]
  /** The loop limit's record for the branch checked out (DESIGN 4.16); it survives /devloop done. */
  limit: LoopLimit
  /** The proposer this session started (DESIGN 4.17): it survives /devloop done; a new session starts it over. */
  learner: LearnerRun
}

/**
 * The proposer's run in this session (DESIGN 4.17): the agent at work (null
 * when none), when it started, the repeat groups it was given, and how many
 * runs this session has started (bounded by `learning.maxRuns`).
 */
export type LearnerRun = { agentId: string | null; at: number; groups: string[]; runs: number }

/** One failed round the loop limit counted: a stop handed back for a failed check, or a review round that ended FAIL. */
export type FailedRound = { at: number; kind: 'fix' | 'review'; what: string; files: string[] }

/**
 * The loop limit's record (DESIGN 4.16): failed rounds on `branch` since a
 * person last allowed more, the rounds a person allowed (`/devloop continue`;
 * null: the policy's number), whether the limit's message was given, and the
 * newest commit on the branch for which the gate was fully met.
 */
export type LoopLimit = {
  branch: string | null
  failed: number
  grant: number | null
  isTold: boolean
  rounds: FailedRound[]
  lastPass: string | null
}

/** One open question the builder could not settle; only a person closes it. */
export type Question = {
  id: string
  question: string
  context: string | null
  at: number
  status: 'open' | 'closed'
  answer: string | null
}

/**
 * Whether the repository opted in, and how hard its guards hold: `off`
 * without devloop.json, `observe` records what it would refuse, `enforce`
 * refuses. Kept as last read, so a guard that fails to run knows what to do.
 */
export type Mode = 'off' | 'observe' | 'enforce'

/** The pane's tabs (C2): which one shows is state, written from a tab button's handler. */
export type PaneTab = 'gate' | 'features' | 'findings' | 'activity' | 'metrics'

/** Whether the rules section is sent, decided once per session id (F6): it survives a plugin reload. */
export type SectionDecision = { sessionId: string | null; isOn: boolean | null }

/** The settings popup's rows, as hooks/settings.ts names them (`RowKey`; the contract imports nothing). */
export type SettingsRow = 'mode' | 'tests' | 'scope' | 'autoReview' | 'approvals' | 'grounding' | 'learning' | 'library'

/**
 * The settings popup's draft: the picks not yet saved (hooks/settings.ts
 * `Changes`: an option's value by row, and a replacement `verify` list), and
 * each row's value when the popup opened, so a pick back to it is no change.
 */
export type SettingsDraft = { changes: Partial<Record<SettingsRow, string>> & { verify?: readonly unknown[] }; openedWith: Record<SettingsRow, string> }

declare module 'claude-code' {
  interface PluginState {
    devloop: { loop: Shaped<Loop>; mode: Mode; tab: PaneTab; section: Shaped<SectionDecision>; settings: Shaped<SettingsDraft | null> }
  }
  // The plugin's own tools, so `e.tool === <name>` narrows to their input.
  interface McpToolInputs {
    mcp__devloop__feature_check: { id: string }
    mcp__devloop__devloop_status: { detail?: boolean }
    mcp__devloop__devloop_review: Record<never, never>
    mcp__devloop__devloop_blocked: { reason: string }
    mcp__devloop__devloop_add_check: { run: string; background?: boolean }
    mcp__devloop__devloop_handoff: {
      objective: string
      decisions?: string[]
      workState?: string
      deadEnds?: string[]
      assumptions?: { assumption: string; command: string }[]
      nextStep: string
      files?: string[]
    }
    mcp__devloop__devloop_question: { question: string; context?: string }
    mcp__devloop__devloop_papercut: { tried: string; expected: string; happened: string; suggestedFix: string; subject?: string }
    mcp__devloop__devloop_claim: { feature: string }
    mcp__devloop__devloop_release: { feature: string }
    mcp__devloop__devloop_library: { query: string; limit?: number }
  }
}
