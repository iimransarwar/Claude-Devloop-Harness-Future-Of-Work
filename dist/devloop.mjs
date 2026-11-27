// devloop: the policy core and the command line, built from hooks/ and cli/ by
// scripts/build.sh. Do not edit: tests/smoke.sh fails when a rebuild differs.
// cli/main.ts
import process4 from "node:process";

// hooks/config.ts
var BUILTIN_RULE_IDS = [
  "secret",
  "harness-state",
  "reviewer-read-only",
  "budget",
  "eval-containment",
  "evidence-notes",
  "spec-locked",
  "protected",
  "tests-locked",
  "spec-first",
  "high-needs-spec",
  "test-weakened",
  "destructive",
  "production",
  "forbidden",
  "egress",
  "no-verify",
  "force-push",
  "check-filtered",
  "human-merge",
  "gate",
  "ship-alone",
  "content-rule",
  "tasks",
  "git-hidden",
  "cache-guard"
];
var DEFAULTS = {
  verify: [],
  verifyTimeoutSec: 300,
  stopTimeoutSec: 60,
  protected: [
    "devloop.json",
    "REVIEW.md",
    "CODEOWNERS",
    ".github/CODEOWNERS",
    ".claude/**",
    "specs/**/features.json",
    "evals/**"
  ],
  tests: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.*",
    "**/test_*.py",
    "test/**",
    "tests/**",
    "**/__tests__/**"
  ],
  secrets: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    ".netrc",
    "**/.aws/credentials",
    "**/credentials*.json"
  ],
  secretsAllow: [".env.example", ".env.sample", ".env.template"],
  instructions: ["AGENTS.md", "CLAUDE.md", ".claude/rules/**", ".claude/skills/**"],
  tiers: {
    high: [
      "**/auth/**",
      "**/payments/**",
      "**/billing/**",
      "**/migrations/**",
      ".github/workflows/**",
      "Dockerfile",
      "**/*.tf"
    ],
    low: ["**/*.md", "docs/**"]
  },
  forbidden: [],
  network: null,
  mode: "enforce",
  maxFixRounds: 2,
  maxReviewRounds: 2,
  autoReview: true,
  budgetUsd: null,
  instructionMaxLines: 200,
  defaultBranch: "main",
  fastReview: { maxFiles: 3, maxLines: 60, model: "sonnet" },
  blastRadius: {
    maxFiles: 25,
    maxLines: 600,
    manifests: ["package.json", "*.lock", "package-lock.json", "go.mod", "go.sum", "Cargo.toml", "requirements*.txt", "pyproject.toml", "Gemfile", "pom.xml", "build.gradle"]
  },
  approvals: { low: 0, medium: 1, high: 2 },
  reviewers: [],
  models: { reviewer: null, specialist: null, eval: null, learner: null },
  cache: { missTokens: 20000, ttlMinutes: 5 },
  context: { budgetTokens: 600, warnRemaining: null, saveRemaining: null, debounceCalls: 25, idleWarnTokens: 50000 },
  instructionsIgnore: [],
  instructionMaxBytes: 32 * 1024,
  checkEnv: { pass: [], mode: "observe" },
  rules: [],
  evalTrials: 1,
  evalIsolation: "worktree",
  evalQuick: 5,
  saturationRuns: 3,
  pruneWindowDays: 30,
  claims: { leaseMinutes: 30 },
  followUp: { ci: true, intervalSec: 120, timeoutMin: 60 },
  tasks: { integrate: "off" },
  grounding: { mode: null, fresh: "turn", also: [], never: [] },
  loop: { failedRounds: 6 },
  testing: { scope: "targeted" },
  learning: { auto: "trial", repeats: 3, promoteHits: 3, maxTrial: 20, maxRuns: 3 },
  library: { save: "auto" }
};
var BUILTIN_SECRETS = [
  "**/.claude/cache-guard/handoffs",
  "**/.claude/cache-guard/handoffs/**",
  "**/.claude/cache-guard/logs",
  "**/.claude/cache-guard/logs/**"
];
var BUILTIN_PROTECTED = [
  "devloop.json",
  "**/.claude/settings*.json",
  ".claude.json",
  ".mcp.json",
  "**/.claude/hooks/**",
  "**/.claude/plugins/**",
  ".claude-plugin/**",
  ".husky/**",
  ".githooks/**",
  "**/.git/hooks/**",
  "**/.git/config",
  "**/.git/refs/notes/**",
  "**/.claude/cache-guard/**",
  ".gitconfig",
  "checklists/**",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".envrc"
];
var RESERVED = ["contextHandoffPercent"];
var RETIRED = ["handoffFile"];
var CHECK_ENV_BASE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "CI"];
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStrings = (v) => Array.isArray(v) && v.every((one) => typeof one === "string");
var unknownKeys = (raw, known, at) => Object.keys(raw).filter((key) => !known.includes(key)).map((key) => `${at}${key}: unknown field`);
function whole(raw, key, fallback, max, errors, overMax) {
  const v = raw[key];
  if (v === undefined) {
    return fallback;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
    const why = overMax !== undefined && typeof v === "number" && Number.isFinite(v) && v > max ? `. ${overMax}` : "";
    errors.push(`${key}: expected a number from 0 to ${max}; using ${fallback}${why}`);
    return fallback;
  }
  return Math.floor(v);
}
function strings(raw, key, fallback, errors, at = "") {
  const v = raw[key];
  if (v === undefined) {
    return fallback;
  }
  if (!isStrings(v)) {
    errors.push(`${at}${key}: expected a list of strings; using the default`);
    return fallback;
  }
  return v;
}
function step(v, at, errors) {
  if (typeof v === "string" && v.trim() !== "") {
    return { run: v, profile: "fast", when: null };
  }
  if (!isObject(v) || typeof v.run !== "string" || v.run.trim() === "") {
    errors.push(`${at}: expected a command, or { "run": "<command>", "profile"?, "when"? }; left out`);
    return null;
  }
  errors.push(...unknownKeys(v, ["run", "profile", "when", "background"], `${at}.`));
  let profile = "fast";
  if (v.profile === "full") {
    profile = "full";
  } else if (v.profile !== undefined && v.profile !== "fast") {
    errors.push(`${at}.profile: expected "fast" or "full"; using "fast"`);
  }
  let when = null;
  if (isStrings(v.when) && v.when.length > 0) {
    when = v.when;
  } else if (v.when !== undefined) {
    errors.push(`${at}.when: expected a non-empty list of globs; the check runs on every change`);
  }
  if (v.background === true) {
    return { run: v.run, profile, when, background: true };
  }
  if (v.background !== undefined && v.background !== false) {
    errors.push(`${at}.background: expected true or false; it runs in the foreground`);
  }
  return { run: v.run, profile, when };
}
function forbidden(v, errors) {
  if (v === undefined) {
    return DEFAULTS.forbidden;
  }
  if (!Array.isArray(v)) {
    errors.push('forbidden: expected a list of { "pattern", "why" }; none applied');
    return [];
  }
  return v.flatMap((one, i) => {
    const at = `forbidden[${i}]`;
    if (!isObject(one) || typeof one.pattern !== "string") {
      errors.push(`${at}: expected { "pattern": "<regular expression>", "why": "<reason>" }; left out`);
      return [];
    }
    errors.push(...unknownKeys(one, ["pattern", "why"], `${at}.`));
    try {
      new RegExp(one.pattern);
    } catch {
      errors.push(`${at}.pattern: not a valid regular expression; left out`);
      return [];
    }
    return [{ pattern: one.pattern, why: typeof one.why === "string" ? one.why : "a person forbade it in devloop.json" }];
  });
}
function network(v, errors) {
  if (v === undefined || v === null) {
    return null;
  }
  if (!isObject(v) || !isStrings(v.allow)) {
    errors.push("network.allow: expected a list of host names; no host is allowed until it is fixed");
    return { allow: [] };
  }
  errors.push(...unknownKeys(v, ["allow"], "network."));
  return { allow: v.allow.map((host) => host.toLowerCase()) };
}
function blastRadius(v, errors) {
  const fallback = DEFAULTS.blastRadius;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('blastRadius: expected { "maxFiles", "maxLines", "manifests" }; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["maxFiles", "maxLines", "manifests"], "blastRadius."));
  const sub = [];
  const out = {
    maxFiles: whole(v, "maxFiles", fallback.maxFiles, 1e5, sub),
    maxLines: whole(v, "maxLines", fallback.maxLines, 1e7, sub),
    manifests: strings(v, "manifests", fallback.manifests, sub)
  };
  errors.push(...sub.map((error) => `blastRadius.${error}`));
  return out;
}
function fastReview(v, errors) {
  const fallback = DEFAULTS.fastReview;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('fastReview: expected { "maxFiles", "maxLines", "model" }; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["maxFiles", "maxLines", "model"], "fastReview."));
  const sub = [];
  const model = v.model === undefined ? fallback.model : v.model === null || typeof v.model === "string" && v.model.trim() !== "" ? v.model : (sub.push("model: expected a model name or null; using the default"), fallback.model);
  const out = {
    maxFiles: whole(v, "maxFiles", fallback.maxFiles, 1e5, sub),
    maxLines: whole(v, "maxLines", fallback.maxLines, 1e7, sub),
    model
  };
  errors.push(...sub.map((error) => `fastReview.${error}`));
  return out;
}
function approvals(v, errors) {
  const fallback = DEFAULTS.approvals;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('approvals: expected { "low", "medium", "high" }, each a number of people; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["low", "medium", "high"], "approvals."));
  const sub = [];
  const out = {
    low: whole(v, "low", fallback.low, 10, sub),
    medium: whole(v, "medium", fallback.medium, 10, sub),
    high: whole(v, "high", fallback.high, 10, sub)
  };
  errors.push(...sub.map((error) => `approvals.${error}`));
  return out;
}
var isModel = (v) => typeof v === "string" && /^[\w.:@/[\]-]{1,100}$/.test(v);
function reviewers(v, errors) {
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    errors.push('reviewers: expected a list of { "name", "when", "mode", "prompt"?, "model"? }; none started');
    return [];
  }
  return v.flatMap((one, i) => {
    const at = `reviewers[${i}]`;
    if (!isObject(one) || typeof one.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(one.name) || !isStrings(one.when) || one.when.length === 0) {
      errors.push(`${at}: expected { "name": "<lowercase-name>", "when": ["<glob>", ...], "mode": "blocking" | "shadow" }; left out`);
      return [];
    }
    errors.push(...unknownKeys(one, ["name", "when", "mode", "prompt", "model"], `${at}.`));
    let mode = "blocking";
    if (one.mode === "shadow") {
      mode = "shadow";
    } else if (one.mode !== "blocking") {
      errors.push(`${at}.mode: expected "blocking" or "shadow"; using "blocking"`);
    }
    if (one.prompt !== undefined && (typeof one.prompt !== "string" || one.prompt.trim() === "")) {
      errors.push(`${at}.prompt: expected the reviewer's brief as text; using the built-in one`);
    }
    if (one.model !== undefined && !isModel(one.model)) {
      errors.push(`${at}.model: expected a model name; using the session's`);
    }
    return [{
      name: one.name,
      when: one.when,
      mode,
      prompt: typeof one.prompt === "string" && one.prompt.trim() !== "" ? one.prompt : null,
      model: isModel(one.model) ? one.model : null
    }];
  });
}
function models(v, errors) {
  if (v === undefined) {
    return DEFAULTS.models;
  }
  if (!isObject(v)) {
    errors.push(`models: expected { "reviewer"?, "specialist"?, "eval"?, "learner"? }; using the session's model`);
    return DEFAULTS.models;
  }
  errors.push(...unknownKeys(v, ["reviewer", "specialist", "eval", "learner"], "models."));
  const pick = (key) => {
    if (v[key] === undefined) {
      return null;
    }
    if (!isModel(v[key])) {
      errors.push(`models.${key}: expected a model name; using the session's`);
      return null;
    }
    return v[key];
  };
  return { reviewer: pick("reviewer"), specialist: pick("specialist"), eval: pick("eval"), learner: pick("learner") };
}
function numbers(v, name, fallback, max, nullable, errors) {
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push(`${name}: expected { ${Object.keys(fallback).map((key) => `"${key}"`).join(", ")} }; using the default`);
    return fallback;
  }
  errors.push(...unknownKeys(v, Object.keys(fallback), `${name}.`));
  const out = { ...fallback };
  const sub = [];
  for (const key of Object.keys(fallback)) {
    if (v[key] === null && nullable.includes(key)) {
      out[key] = null;
    } else if (v[key] !== undefined) {
      const value = v[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max[key]) {
        sub.push(`${key}: expected a number from 0 to ${max[key]}; using ${fallback[key] ?? "the default (scaled to the window)"}`);
      } else {
        out[key] = Math.floor(value);
      }
    }
  }
  errors.push(...sub.map((error) => `${name}.${error}`));
  return out;
}
function checkEnv(v, errors) {
  const fallback = DEFAULTS.checkEnv;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('checkEnv: expected { "pass": [names], "mode": "off" | "observe" | "enforce" }; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["pass", "mode"], "checkEnv."));
  let mode = fallback.mode;
  if (v.mode === "off" || v.mode === "observe" || v.mode === "enforce") {
    mode = v.mode;
  } else if (v.mode !== undefined) {
    errors.push('checkEnv.mode: expected "off", "observe" or "enforce"; using "observe"');
  }
  let pass = [];
  if (isStrings(v.pass) && v.pass.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    pass = v.pass;
  } else if (v.pass !== undefined) {
    errors.push("checkEnv.pass: expected a list of variable names; none passed beyond the base");
  }
  return { pass, mode };
}
function contentRules(v, errors) {
  if (v === undefined) {
    return [];
  }
  if (!Array.isArray(v)) {
    errors.push('rules: expected a list of { "id", "when", "pattern", "action", "why" }; none applied');
    return [];
  }
  const seen = new Set;
  return v.flatMap((one, i) => {
    const at = `rules[${i}]`;
    if (!isObject(one) || typeof one.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(one.id) || !isStrings(one.when) || one.when.length === 0 || typeof one.pattern !== "string" || one.pattern === "") {
      errors.push(`${at}: expected { "id": "<lowercase-name>", "when": ["<glob>", ...], "pattern": "<regular expression>", "action": "note" | "refuse" | "ratchet", "why": "<reason>" }; left out`);
      return [];
    }
    if (BUILTIN_RULE_IDS.includes(one.id)) {
      errors.push(`${at}.id: "${one.id}" is a built-in rule's name; left out`);
      return [];
    }
    if (seen.has(one.id)) {
      errors.push(`${at}.id: "${one.id}" is used twice; the later one is left out`);
      return [];
    }
    seen.add(one.id);
    errors.push(...unknownKeys(one, ["id", "when", "pattern", "action", "why"], `${at}.`));
    try {
      new RegExp(one.pattern);
    } catch {
      errors.push(`${at}.pattern: not a valid regular expression; left out`);
      return [];
    }
    let action = "refuse";
    if (one.action === "note" || one.action === "refuse" || one.action === "ratchet") {
      action = one.action;
    } else {
      errors.push(`${at}.action: expected "note", "refuse" or "ratchet"; using "refuse"`);
    }
    return [{ id: one.id, when: one.when, pattern: one.pattern, action, why: typeof one.why === "string" ? one.why : "a person wrote this rule in devloop.json" }];
  });
}
function followUp(v, errors) {
  const fallback = DEFAULTS.followUp;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('followUp: expected { "ci", "intervalSec", "timeoutMin" }; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["ci", "intervalSec", "timeoutMin"], "followUp."));
  let ci = fallback.ci;
  if (typeof v.ci === "boolean") {
    ci = v.ci;
  } else if (v.ci !== undefined) {
    errors.push("followUp.ci: expected true or false; using true");
  }
  const sub = [];
  const intervalSec = Math.max(30, whole(v, "intervalSec", fallback.intervalSec, 3600, sub));
  const timeoutMin = Math.max(1, whole(v, "timeoutMin", fallback.timeoutMin, 1440, sub));
  errors.push(...sub.map((error) => `followUp.${error}`));
  return { ci, intervalSec, timeoutMin };
}
function tasks(v, errors) {
  if (v === undefined) {
    return DEFAULTS.tasks;
  }
  if (!isObject(v)) {
    errors.push('tasks: expected { "integrate": "off" | "observe" | "enforce" }; using "off"');
    return DEFAULTS.tasks;
  }
  errors.push(...unknownKeys(v, ["integrate"], "tasks."));
  if (v.integrate === "off" || v.integrate === "observe" || v.integrate === "enforce") {
    return { integrate: v.integrate };
  }
  if (v.integrate !== undefined) {
    errors.push('tasks.integrate: expected "off", "observe" or "enforce"; using "off"');
  }
  return DEFAULTS.tasks;
}
function grounding(v, errors) {
  const fallback = DEFAULTS.grounding;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('grounding: expected { "mode", "fresh", "also", "never" }; using the default');
    return fallback;
  }
  errors.push(...unknownKeys(v, ["mode", "fresh", "also", "never"], "grounding."));
  let mode = fallback.mode;
  if (v.mode === "off" || v.mode === "observe" || v.mode === "enforce") {
    mode = v.mode;
  } else if (v.mode !== undefined) {
    errors.push(`grounding.mode: expected "off", "observe" or "enforce"; following the policy's mode`);
  }
  let fresh = fallback.fresh;
  if (v.fresh === "turn" || v.fresh === "tree") {
    fresh = v.fresh;
  } else if (v.fresh !== undefined) {
    errors.push('grounding.fresh: expected "turn" or "tree"; using "turn"');
  }
  const patterns = (key) => {
    const raw = v[key];
    if (raw === undefined) {
      return [];
    }
    if (!Array.isArray(raw)) {
      errors.push(`grounding.${key}: expected a list of patterns; using none`);
      return [];
    }
    return raw.flatMap((one, i) => {
      if (typeof one !== "string" || one === "") {
        errors.push(`grounding.${key}[${i}]: expected a pattern; left out`);
        return [];
      }
      try {
        new RegExp(one, "i");
      } catch {
        errors.push(`grounding.${key}[${i}]: not a valid regular expression; left out`);
        return [];
      }
      return [one];
    });
  };
  return { mode, fresh, also: patterns("also"), never: patterns("never") };
}
function loopLimit(v, errors) {
  if (v === undefined) {
    return DEFAULTS.loop;
  }
  if (!isObject(v)) {
    errors.push(`loop: expected { "failedRounds": <a number from 0 to 100> }; using ${DEFAULTS.loop.failedRounds}`);
    return DEFAULTS.loop;
  }
  errors.push(...unknownKeys(v, ["failedRounds"], "loop."));
  const sub = [];
  const failedRounds = whole(v, "failedRounds", DEFAULTS.loop.failedRounds, 100, sub);
  errors.push(...sub.map((error) => `loop.${error}`));
  return { failedRounds };
}
function testing(v, errors) {
  if (v === undefined) {
    return DEFAULTS.testing;
  }
  if (!isObject(v)) {
    errors.push('testing: expected { "scope": "targeted" | "full" }; using "full"');
    return { scope: "full" };
  }
  errors.push(...unknownKeys(v, ["scope"], "testing."));
  if (v.scope === "targeted" || v.scope === "full") {
    return { scope: v.scope };
  }
  if (v.scope !== undefined) {
    errors.push('testing.scope: expected "targeted" or "full"; using "full"');
    return { scope: "full" };
  }
  return DEFAULTS.testing;
}
function learning(v, errors) {
  const fallback = DEFAULTS.learning;
  if (v === undefined) {
    return fallback;
  }
  if (!isObject(v)) {
    errors.push('learning: expected { "auto", "repeats", "promoteHits", "maxTrial", "maxRuns" }; using "off"');
    return { ...fallback, auto: "off" };
  }
  errors.push(...unknownKeys(v, ["auto", "repeats", "promoteHits", "maxTrial", "maxRuns"], "learning."));
  let auto = fallback.auto;
  if (v.auto === "off" || v.auto === "propose" || v.auto === "trial") {
    auto = v.auto;
  } else if (v.auto !== undefined) {
    errors.push('learning.auto: expected "off", "propose" or "trial"; using "off"');
    auto = "off";
  }
  const sub = [];
  const atLeastOne = (key) => {
    const n = whole(v, key, fallback[key], 100, sub);
    if (n >= 1) {
      return n;
    }
    sub.push(`${key}: expected a number from 1 to 100; using ${fallback[key]}`);
    return fallback[key];
  };
  const repeats = atLeastOne("repeats");
  const promoteHits = atLeastOne("promoteHits");
  const maxTrial = whole(v, "maxTrial", fallback.maxTrial, 100, sub);
  const maxRuns = whole(v, "maxRuns", fallback.maxRuns, 100, sub);
  errors.push(...sub.map((error) => `learning.${error}`));
  return { auto, repeats, promoteHits, maxTrial, maxRuns };
}
function library(v, errors) {
  if (v === undefined) {
    return DEFAULTS.library;
  }
  if (!isObject(v)) {
    errors.push('library: expected { "save": "auto" | "off" }; using "off"');
    return { save: "off" };
  }
  errors.push(...unknownKeys(v, ["save"], "library."));
  if (v.save === "auto" || v.save === "off" || v.save === undefined) {
    return { save: v.save ?? DEFAULTS.library.save };
  }
  errors.push('library.save: expected "auto" or "off"; using "off"');
  return { save: "off" };
}
var KNOWN = [
  ...Object.keys(DEFAULTS),
  ...RESERVED,
  ...RETIRED,
  "$schema"
];
function parseConfig(text) {
  let raw;
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) {
      return { cfg: DEFAULTS, isParsed: false, errors: ["devloop.json must hold one JSON object; every field takes its default"], unused: [] };
    }
    raw = parsed;
  } catch (error) {
    const why = error instanceof Error ? `: ${error.message}` : "";
    return { cfg: DEFAULTS, isParsed: false, errors: [`devloop.json is not valid JSON${why}; every field takes its default`], unused: [] };
  }
  const errors = unknownKeys(raw, KNOWN, "");
  let verify = DEFAULTS.verify;
  if (Array.isArray(raw.verify)) {
    verify = raw.verify.flatMap((one, i) => step(one, `verify[${i}]`, errors) ?? []);
  } else if (typeof raw.verify === "string" || isObject(raw.verify)) {
    verify = [step(raw.verify, "verify", errors)].flatMap((one) => one ?? []);
  } else if (raw.verify !== undefined) {
    errors.push("verify: expected a command or a list of commands; nothing is verified until it is fixed");
  }
  let tiers = DEFAULTS.tiers;
  if (isObject(raw.tiers)) {
    errors.push(...unknownKeys(raw.tiers, ["high", "low"], "tiers."));
    tiers = {
      high: strings(raw.tiers, "high", DEFAULTS.tiers.high, errors, "tiers."),
      low: strings(raw.tiers, "low", DEFAULTS.tiers.low, errors, "tiers.")
    };
  } else if (raw.tiers !== undefined) {
    errors.push('tiers: expected { "high": [...], "low": [...] }; using the default');
  }
  let mode = DEFAULTS.mode;
  if (raw.mode === "observe" || raw.mode === "enforce") {
    mode = raw.mode;
  } else if (raw.mode !== undefined) {
    errors.push(`mode: expected "observe" or "enforce"; using "${DEFAULTS.mode}"`);
  }
  let budgetUsd = DEFAULTS.budgetUsd;
  if (typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd > 0) {
    budgetUsd = raw.budgetUsd;
  } else if (raw.budgetUsd !== undefined && raw.budgetUsd !== null) {
    errors.push("budgetUsd: expected a number of US dollars above 0, or null; no cap");
  }
  let autoReview = DEFAULTS.autoReview;
  if (typeof raw.autoReview === "boolean") {
    autoReview = raw.autoReview;
  } else if (raw.autoReview !== undefined) {
    errors.push("autoReview: expected true or false; using true");
  }
  let defaultBranch = DEFAULTS.defaultBranch;
  if (typeof raw.defaultBranch === "string" && raw.defaultBranch.trim() !== "") {
    defaultBranch = raw.defaultBranch.trim();
  } else if (raw.defaultBranch !== undefined) {
    errors.push(`defaultBranch: expected a branch name; using "${DEFAULTS.defaultBranch}"`);
  }
  let evalIsolation = DEFAULTS.evalIsolation;
  if (raw.evalIsolation === "worktree" || raw.evalIsolation === "clone") {
    evalIsolation = raw.evalIsolation;
  } else if (raw.evalIsolation !== undefined) {
    errors.push('evalIsolation: expected "worktree" or "clone"; using "worktree"');
  }
  const cfg = {
    verify,
    verifyTimeoutSec: whole(raw, "verifyTimeoutSec", DEFAULTS.verifyTimeoutSec, 600, errors, 'Mark long checks "background": true in verify: they run with no time limit, and only shipping waits for them'),
    stopTimeoutSec: whole(raw, "stopTimeoutSec", DEFAULTS.stopTimeoutSec, 600, errors),
    protected: strings(raw, "protected", DEFAULTS.protected, errors),
    tests: strings(raw, "tests", DEFAULTS.tests, errors),
    secrets: strings(raw, "secrets", DEFAULTS.secrets, errors),
    secretsAllow: strings(raw, "secretsAllow", DEFAULTS.secretsAllow, errors),
    instructions: strings(raw, "instructions", DEFAULTS.instructions, errors),
    tiers,
    forbidden: forbidden(raw.forbidden, errors),
    network: network(raw.network, errors),
    mode,
    maxFixRounds: whole(raw, "maxFixRounds", DEFAULTS.maxFixRounds, 10, errors),
    maxReviewRounds: whole(raw, "maxReviewRounds", DEFAULTS.maxReviewRounds, 10, errors),
    autoReview,
    budgetUsd,
    instructionMaxLines: whole(raw, "instructionMaxLines", DEFAULTS.instructionMaxLines, 1e4, errors),
    defaultBranch,
    blastRadius: blastRadius(raw.blastRadius, errors),
    fastReview: fastReview(raw.fastReview, errors),
    approvals: approvals(raw.approvals, errors),
    reviewers: reviewers(raw.reviewers, errors),
    models: models(raw.models, errors),
    cache: numbers(raw.cache, "cache", DEFAULTS.cache, { missTokens: 1e7, ttlMinutes: 1440 }, [], errors),
    context: numbers(raw.context, "context", DEFAULTS.context, { budgetTokens: 1e5, warnRemaining: 1e8, saveRemaining: 1e8, debounceCalls: 1e4, idleWarnTokens: 1e8 }, ["warnRemaining", "saveRemaining"], errors),
    instructionsIgnore: strings(raw, "instructionsIgnore", DEFAULTS.instructionsIgnore, errors),
    instructionMaxBytes: whole(raw, "instructionMaxBytes", DEFAULTS.instructionMaxBytes, 1e8, errors),
    checkEnv: checkEnv(raw.checkEnv, errors),
    rules: contentRules(raw.rules, errors),
    evalTrials: Math.max(1, whole(raw, "evalTrials", DEFAULTS.evalTrials, 10, errors)),
    evalIsolation,
    evalQuick: Math.max(1, whole(raw, "evalQuick", DEFAULTS.evalQuick, 1000, errors)),
    saturationRuns: Math.max(2, whole(raw, "saturationRuns", DEFAULTS.saturationRuns, 50, errors)),
    pruneWindowDays: whole(raw, "pruneWindowDays", DEFAULTS.pruneWindowDays, 3650, errors),
    claims: { leaseMinutes: Math.max(1, numbers(raw.claims, "claims", DEFAULTS.claims, { leaseMinutes: 1440 }, [], errors).leaseMinutes) },
    followUp: followUp(raw.followUp, errors),
    tasks: tasks(raw.tasks, errors),
    grounding: grounding(raw.grounding, errors),
    loop: loopLimit(raw.loop, errors),
    testing: testing(raw.testing, errors),
    learning: learning(raw.learning, errors),
    library: library(raw.library, errors)
  };
  return { cfg, isParsed: true, errors, unused: [...RESERVED, ...RETIRED].filter((key) => (key in raw)) };
}

// hooks/fresh.ts
var FRESH = {
  root: null,
  sessionId: null,
  phase: "idle",
  spec: null,
  approvedHash: null,
  features: {},
  dependsOn: {},
  approval: null,
  testHashes: null,
  newTests: [],
  assertionDrops: [],
  exemptionsUsed: [],
  evidence: { tree: null, credentials: [], testsChanged: [], testsAdded: [], hidden: [] },
  tree: null,
  isBaseKnown: true,
  isDirty: false,
  changed: [],
  hasTouchedTests: false,
  tier: "none",
  size: { files: 0, lines: 0 },
  verify: { status: "none", rounds: 0, failed: null, at: 0, tree: null, profile: "none", fingerprint: null, passedOn: {}, covered: {}, blockedTree: null, infra: null, runs: {} },
  background: {},
  review: {
    status: "none",
    round: 0,
    agentId: null,
    isAuto: false,
    summary: null,
    at: 0,
    tree: null,
    agents: [],
    stalled: 0,
    isStalled: false,
    isLooping: false,
    cycle: { from: 1, ended: null, summary: null, discarded: 0, settledTree: null, toldTree: null, followUp: null }
  },
  findings: [],
  allow: [],
  refusals: { rule: "", count: 0 },
  blocked: null,
  budgetUsd: null,
  isOverBudget: false,
  base: null,
  events: [],
  evalRun: null,
  ignoredBase: null,
  regressions: {},
  tally: { startedAt: null, fixRounds: 0 },
  agentWritten: [],
  task: null,
  checklistFails: [],
  limit: { branch: null, failed: 0, grant: null, isTold: false, rounds: [], lastPass: null },
  learner: { agentId: null, at: 0, groups: [], runs: 0 }
};

// hooks/glob.ts
var GLOB_CAP = 200;
var LIST_CAP = 64;
var isWildPart = (part) => /[*?[]/.test(part);
var cache = new Map;
function partRegex(part) {
  const known = cache.get(part);
  if (known !== undefined) {
    return known;
  }
  let source = "";
  for (let i = 0;i < part.length; i += 1) {
    const c = part[i] ?? "";
    if (c === "\\") {
      source += (part[i + 1] ?? "").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    } else if (c === "*") {
      source += ".*";
    } else if (c === "?") {
      source += ".";
    } else if (c === "[") {
      const end = part.indexOf("]", i + (part[i + 1] === "]" || part[i + 1] === "!" || part[i + 1] === "^" ? 2 : 1));
      if (end < 0) {
        source += "\\[";
        continue;
      }
      const body = part.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&")}]`;
      i = end;
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  const made = new RegExp(`^${source}$`);
  cache.set(part, made);
  return made;
}
var isMatch = (name, part) => (!name.startsWith(".") || part.startsWith(".")) && name !== "." && name !== ".." && partRegex(part).test(name);
function expandGlob(pattern, listed) {
  if (!pattern.startsWith("/")) {
    return { matches: [] };
  }
  const parts = pattern.split("/").slice(1);
  const isFolders = pattern.endsWith("/");
  let found = [""];
  let lists = 0;
  let isAfterWild = !parts.some(isWildPart);
  for (const [i, part] of parts.entries()) {
    if (part === "") {
      continue;
    }
    const isLast = parts.slice(i + 1).every((one) => one === "") && !isFolders;
    const isWild = isWildPart(part);
    if (!isWild && (!isAfterWild || part === "." || part === "..")) {
      found = found.map((one) => `${one}/${part.replace(/\\(.)/g, "$1")}`);
      continue;
    }
    isAfterWild = true;
    const literal = part.replace(/\\(.)/g, "$1");
    const need = [];
    const next = [];
    for (const one of found) {
      const dir = one === "" ? "/" : one;
      const listing = listed(dir);
      lists += 1;
      if (listing === undefined) {
        need.push(dir);
        continue;
      }
      for (const entry of listing ?? []) {
        if ((isLast || entry.isDir !== false) && (isWild ? isMatch(entry.name, part) : entry.name === literal)) {
          next.push(`${one}/${entry.name}`);
        }
      }
    }
    if (lists > LIST_CAP || next.length > GLOB_CAP) {
      return "capped";
    }
    if (need.length > 0) {
      return { need: [...new Set(need)] };
    }
    found = next;
  }
  return { matches: found.filter((one) => one !== "").sort() };
}
function expandGlobReviewed(pattern, listed) {
  if (!pattern.startsWith("/")) {
    return { matches: [] };
  }
  const parts = pattern.split("/").slice(1);
  let found = [""];
  let lists = 0;
  for (const [i, part] of parts.entries()) {
    if (part === "") {
      continue;
    }
    const isLast = parts.slice(i + 1).every((one) => one === "");
    if (!isWildPart(part)) {
      found = found.map((one) => `${one}/${part.replace(/\\(.)/g, "$1")}`);
      continue;
    }
    const need = [];
    const next = [];
    for (const one of found) {
      const dir = one === "" ? "/" : one;
      const listing = listed(dir);
      lists += 1;
      if (listing === undefined) {
        need.push(dir);
        continue;
      }
      for (const entry of listing ?? []) {
        if ((isLast || entry.isDir === true) && isMatch(entry.name, part)) {
          next.push(`${one}/${entry.name}`);
        }
      }
    }
    if (lists > LIST_CAP || next.length > GLOB_CAP) {
      return "capped";
    }
    if (need.length > 0) {
      return { need: [...new Set(need)] };
    }
    found = next;
  }
  return { matches: found.filter((one) => one !== "").sort() };
}
function expandAllNow(patterns, list, expand = expandGlob) {
  const known = new Map;
  const out = {};
  for (const pattern of patterns) {
    for (let round = 0;round < LIST_CAP; round += 1) {
      const step = expand(pattern, (dir) => known.get(dir));
      if (step === "capped") {
        out[pattern] = "capped";
        break;
      }
      if ("matches" in step) {
        out[pattern] = step.matches;
        break;
      }
      for (const dir of step.need) {
        known.set(dir, list(dir));
      }
    }
    out[pattern] ??= "capped";
  }
  return out;
}

// hooks/shell.ts
var isSpace = (c) => c === " " || c === "\t" || c === "\r";
var SPECIAL = "*?[]{},\\\x01\x02";
var encode = (c, isQuoted) => isQuoted && SPECIAL.includes(c) || c === "\x01" || c === "\x02" ? `\\${c}` : c;
function templateText(template) {
  let out = "";
  for (let i = 0;i < template.length; i += 1) {
    const c = template[i] ?? "";
    if (c === "\\") {
      out += template[i + 1] ?? "";
      i += 1;
    } else if (c === "\x01") {
      const end = template.indexOf("\x02", i);
      i = end < 0 ? template.length : end;
    } else {
      out += c;
    }
  }
  return out;
}
function holds(template, set) {
  for (let i = 0;i < template.length; i += 1) {
    const c = template[i] ?? "";
    if (c === "\\") {
      i += 1;
    } else if (c === "\x01") {
      const end = template.indexOf("\x02", i);
      i = end < 0 ? template.length : end;
    } else if (set.includes(c)) {
      return true;
    }
  }
  return false;
}
function hasMarker(template) {
  for (let i = 0;i < template.length; i += 1) {
    if (template[i] === "\\") {
      i += 1;
    } else if (template[i] === "\x01") {
      return true;
    }
  }
  return false;
}
var isGlobTemplate = (template) => holds(template, "*?[");
function resolveTemplate(template, value) {
  let out = "";
  for (let i = 0;i < template.length; i += 1) {
    const c = template[i] ?? "";
    if (c === "\\") {
      out += template.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (c !== "\x01") {
      out += c;
      continue;
    }
    const end = template.indexOf("\x02", i);
    const inner = template.slice(i + 1, end < 0 ? template.length : end);
    i = end < 0 ? template.length : end;
    const named = /^([uq]):([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner);
    if (named === null) {
      return null;
    }
    const found = value(named[2] ?? "");
    if (found === null) {
      return null;
    }
    const isQuoted = named[1] === "q";
    if (!isQuoted && /\s/.test(found)) {
      return null;
    }
    out += [...found].map((one) => isQuoted ? encode(one, true) : "{},\\\x01\x02".includes(one) ? `\\${one}` : one).join("");
  }
  return out;
}
var BRACE_CAP = 200;
function braceAlternatives(body) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0;i < body.length; i += 1) {
    const c = body[i] ?? "";
    if (c === "\\") {
      i += 1;
    } else if (c === "\x01") {
      const end = body.indexOf("\x02", i);
      i = end < 0 ? body.length : end;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  if (parts.length > 0) {
    return [...parts, body.slice(from)];
  }
  const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (range === null) {
    return null;
  }
  const [, a = "", b = "", stepText] = range;
  const isNumber = /\d/.test(a) && /\d/.test(b);
  if (!isNumber && (/\d/.test(a) || /\d/.test(b))) {
    return null;
  }
  const start = isNumber ? Number(a) : a.charCodeAt(0);
  const stop = isNumber ? Number(b) : b.charCodeAt(0);
  const step = Math.max(1, Math.abs(Number(stepText ?? 1)) || 1);
  const out = [];
  for (let n = start;start <= stop ? n <= stop : n >= stop; n += start <= stop ? step : -step) {
    out.push(isNumber ? String(n) : String.fromCharCode(n));
    if (out.length > BRACE_CAP) {
      break;
    }
  }
  return out;
}
function braceExpand(template) {
  for (let i = 0;i < template.length; i += 1) {
    const c = template[i] ?? "";
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "\x01") {
      const end = template.indexOf("\x02", i);
      i = end < 0 ? template.length : end;
      continue;
    }
    if (c !== "{") {
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = i;j < template.length; j += 1) {
      const d = template[j] ?? "";
      if (d === "\\") {
        j += 1;
      } else if (d === "\x01") {
        const end = template.indexOf("\x02", j);
        j = end < 0 ? template.length : end;
      } else if (d === "{") {
        depth += 1;
      } else if (d === "}") {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) {
      return [template];
    }
    const alternatives = braceAlternatives(template.slice(i + 1, close));
    if (alternatives === null) {
      const rest = braceExpand(template.slice(i + 1));
      if (rest === null) {
        return null;
      }
      return rest.map((one) => `${template.slice(0, i + 1)}${one}`);
    }
    const out = [];
    const head = template.slice(0, i);
    for (const one of alternatives) {
      const expanded = braceExpand(`${one}${template.slice(close + 1)}`);
      if (expanded === null) {
        return null;
      }
      for (const tail of expanded) {
        out.push(`${head}${tail}`);
        if (out.length > BRACE_CAP) {
          return null;
        }
      }
    }
    return out;
  }
  return [template];
}
function closing(text, from, isArithmetic = false) {
  let depth = 1;
  for (let i = from;i < text.length; i += 1) {
    const c = text[i];
    const heredoc = c === "<" && !isArithmetic ? /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i)) : null;
    if (heredoc !== null) {
      const start = text.indexOf(`
`, i);
      const delimiter = heredoc[2] ?? "";
      let end = start;
      while (end >= 0) {
        const next = text.indexOf(`
`, end + 1);
        const line = text.slice(end + 1, next < 0 ? text.length : next);
        if (line.replace(/^\t+/, "") === delimiter) {
          end = next < 0 ? text.length : next;
          break;
        }
        end = next;
      }
      i = start < 0 ? i + heredoc[0].length - 1 : end < 0 ? text.length : end;
    } else if (c === "\\") {
      i += 1;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      for (i += 1;i < text.length && text[i] !== '"'; i += 1) {
        if (text[i] === "\\") {
          i += 1;
        }
      }
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length;
}
function braceEnd(text, from) {
  let depth = 1;
  for (let i = from;i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length;
}
var READINGS = ["reviewed", "extended"];
var ANSI_C = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
  a: "\x07",
  b: "\b",
  e: "\x1B",
  E: "\x1B",
  f: "\f",
  n: `
`,
  r: "\r",
  t: "\t",
  v: "\v"
};
function decodeAnsiC(body) {
  let text = "";
  let isUnknown = false;
  for (let i = 0;i < body.length; i += 1) {
    const c = body[i] ?? "";
    if (c !== "\\") {
      text += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      text += "\\";
      break;
    }
    if (next === "x" && body[i + 2] === "{") {
      const digits = /^[0-9A-Fa-f]*/.exec(body.slice(i + 3))?.[0] ?? "";
      const code = parseInt(digits.slice(-2) || "0", 16);
      i += 2 + digits.length + (body[i + 3 + digits.length] === "}" ? 1 : 0);
      if (code === 0) {
        break;
      }
      if (code > 127) {
        isUnknown = true;
        continue;
      }
      text += String.fromCharCode(code);
      continue;
    }
    const one = ANSI_C[next];
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    const hex = next === "x" ? /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 2)) : next === "u" ? /^[0-9A-Fa-f]{1,4}/.exec(body.slice(i + 2)) : next === "U" ? /^[0-9A-Fa-f]{1,8}/.exec(body.slice(i + 2)) : null;
    let code = null;
    if (one !== undefined) {
      text += one;
      i += 1;
      continue;
    } else if (octal !== null) {
      code = parseInt(octal[0], 8) & 255;
      i += octal[0].length;
    } else if (hex !== null) {
      code = parseInt(hex[0], 16);
      i += 1 + hex[0].length;
    } else if (next === "c" && body[i + 2] !== undefined) {
      const x = body[i + 2] ?? "";
      const at = x.codePointAt(0) ?? 0;
      if (at < 32 || at > 126) {
        text += body.slice(i, i + 2 + x.length);
        isUnknown = true;
        i += 1 + x.length;
        continue;
      }
      code = x === "?" ? 127 : x.toUpperCase().charCodeAt(0) & 31;
      i += x === "\\" && body[i + 3] === "\\" ? 3 : 2;
    }
    const isByte = next === "x" || octal !== null;
    if (code === null) {
      text += body.slice(i, i + 2);
      isUnknown = true;
      i += 1;
      continue;
    }
    if (code === 0) {
      break;
    }
    if (isByte && code > 127 || code > 1114111 || code >= 55296 && code <= 57343) {
      isUnknown = true;
      continue;
    }
    text += String.fromCodePoint(code);
  }
  return { text, isUnknown };
}
function tokenize(text, reading) {
  const tokens = [];
  let word = null;
  let subs = [];
  let heredocs = [];
  let pending = null;
  const part = () => {
    word ??= { text: "", isQuoted: false, hasExpansion: false, hasGlob: false, template: "" };
    return word;
  };
  const add = (w, chars, isQuoted) => {
    w.text += chars;
    w.template = `${w.template ?? ""}${[...chars].map((one) => encode(one, isQuoted)).join("")}`;
  };
  const mark = (w, name, isQuoted) => {
    w.template = `${w.template ?? ""}\x01${name === null ? "?" : `${isQuoted ? "q" : "u"}:${name}`}\x02`;
  };
  const flush = () => {
    if (word === null) {
      return;
    }
    if (pending !== null) {
      if (pending.isHeredoc) {
        heredocs.push({ delimiter: word.text, isTabbed: pending.isTabbed });
        tokens.push({ kind: "redirect", op: pending.op, target: null, subs });
      } else {
        tokens.push({ kind: "redirect", op: pending.op, target: word, subs });
      }
      pending = null;
    } else {
      tokens.push({ kind: "word", word, subs });
    }
    word = null;
    subs = [];
  };
  const op = (value) => {
    flush();
    tokens.push({ kind: "op", op: value });
  };
  const dollar = (i, isQuoted) => {
    const w = part();
    const had = w.hasExpansion;
    const isFirst = w.text === "" && !had;
    w.lead = null;
    w.hasExpansion = true;
    const next = text[i + 1];
    if (next === "(" && text[i + 2] === "(") {
      const end = closing(text, i + 3, true);
      mark(w, null, isQuoted);
      return Math.min(text.length, end + 1);
    }
    if (next === "(") {
      const end = closing(text, i + 2);
      subs.push(text.slice(i + 2, end));
      mark(w, null, isQuoted);
      return end;
    }
    if (next === "{") {
      const end = braceEnd(text, i + 2);
      const inner = text.slice(i + 2, end);
      const isName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner);
      w.lead = isFirst && isName ? inner : null;
      mark(w, isName ? inner : null, isQuoted);
      return end;
    }
    if (next === "'" && reading === "reviewed") {
      w.hasExpansion = had;
      w.isQuoted = true;
      let j = i + 2;
      for (;j < text.length && text[j] !== "'"; j += 1) {
        if (text[j] === "\\") {
          j += 1;
        }
        add(w, text[j] ?? "", true);
      }
      return j;
    }
    if (next === "'" && !isQuoted) {
      w.hasExpansion = had;
      w.isQuoted = true;
      let j = i + 2;
      for (;j < text.length && text[j] !== "'"; j += 1) {
        if (text[j] === "\\") {
          j += 1;
        }
      }
      const decoded = decodeAnsiC(text.slice(i + 2, j));
      add(w, decoded.text, true);
      if (decoded.isUnknown) {
        w.hasExpansion = true;
        w.lead = null;
        mark(w, null, true);
      }
      return j;
    }
    if (next === '"' && !isQuoted && reading === "extended") {
      w.hasExpansion = had;
      return i;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i + 1));
    if (name === null) {
      w.hasExpansion = had;
      add(w, "$", isQuoted);
      return i;
    }
    const isName = /^[A-Za-z_]/.test(name[0]);
    w.lead = isFirst && isName ? name[0] : null;
    mark(w, isName ? name[0] : null, isQuoted);
    return i + name[0].length;
  };
  for (let i = 0;i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (c === "\\") {
      if (text[i + 1] === `
`) {
        i += 1;
        continue;
      }
      add(part(), text[i + 1] ?? "", true);
      part().isQuoted = true;
      i += 1;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      add(part(), text.slice(i + 1, stop), true);
      part().isQuoted = true;
      i = stop;
    } else if (c === '"') {
      const w = part();
      w.isQuoted = true;
      let j = i + 1;
      for (;j < text.length && text[j] !== '"'; j += 1) {
        const d = text[j] ?? "";
        if (d === "\\" && '$`"\\\n'.includes(text[j + 1] ?? "")) {
          add(w, text[j + 1] === `
` ? "" : text[j + 1] ?? "", true);
          j += 1;
        } else if (d === "$") {
          j = dollar(j, true);
        } else if (d === "`") {
          const end = text.indexOf("`", j + 1);
          const stop = end < 0 ? text.length : end;
          subs.push(text.slice(j + 1, stop));
          w.hasExpansion = true;
          w.lead = null;
          mark(w, null, true);
          j = stop;
        } else {
          add(w, d, true);
        }
      }
      i = j;
    } else if (c === "$") {
      i = dollar(i, false);
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end < 0 ? text.length : end;
      subs.push(text.slice(i + 1, stop));
      part().hasExpansion = true;
      part().lead = null;
      mark(part(), null, false);
      i = stop;
    } else if (c === "#" && word === null) {
      while (i + 1 < text.length && text[i + 1] !== `
`) {
        i += 1;
      }
    } else if (c === `
`) {
      op(`
`);
      if (heredocs.length > 0) {
        for (const { delimiter, isTabbed } of heredocs) {
          for (;; ) {
            const end = text.indexOf(`
`, i + 1);
            const line = text.slice(i + 1, end < 0 ? text.length : end);
            i = end < 0 ? text.length : end;
            if ((isTabbed ? line.replace(/^\t+/, "") : line) === delimiter || end < 0) {
              break;
            }
          }
        }
        heredocs = [];
      }
    } else if (isSpace(c)) {
      flush();
    } else if (c === ";") {
      op(text[i + 1] === ";" ? ";;" : ";");
      if (text[i + 1] === ";") {
        i += 1;
      }
    } else if (c === "&" && text[i + 1] === "&") {
      op("&&");
      i += 1;
    } else if (c === "|" && text[i + 1] === "|") {
      op("||");
      i += 1;
    } else if (c === "|") {
      op(text[i + 1] === "&" ? "|&" : "|");
      if (text[i + 1] === "&") {
        i += 1;
      }
    } else if ((c === "<" || c === ">") && text[i + 1] === "(") {
      const end = closing(text, i + 2);
      subs.push(text.slice(i + 2, end));
      part().text += "/dev/fd/63";
      mark(part(), null, false);
      part().hasExpansion = true;
      i = end;
    } else if (c === "&" && text[i + 1] === ">") {
      flush();
      const isAppend = text[i + 2] === ">";
      pending = { op: isAppend ? "&>>" : "&>", isHeredoc: false, isTabbed: false };
      i += isAppend ? 2 : 1;
    } else if (c === "&") {
      op("&");
    } else if (c === "(" && text[i + 1] === "(" && word === null && text[closing(text, i + 2, true) + 1] === ")") {
      flush();
      tokens.push({ kind: "word", word: { text: "((", isQuoted: false, hasExpansion: false, hasGlob: false }, subs: [] });
      i = closing(text, i + 2, true) + 1;
    } else if (c === "(" || c === ")") {
      op(c);
    } else if (c === "<" || c === ">") {
      const current = word;
      const fd = current !== null && /^\d+$/.test(current.text) && !current.isQuoted ? current.text : "";
      if (fd !== "") {
        word = null;
      } else {
        flush();
      }
      const rest = text.slice(i);
      const found = /^(<<<|<<-|<<|<>|<&|>>|>\||>&|<|>)/.exec(rest)?.[1] ?? c;
      i += found.length - 1;
      if (found === ">&" || found === "<&") {
        const target = /^\s*([0-9]+-?|-)/.exec(text.slice(i + 1));
        if (target !== null) {
          tokens.push({ kind: "redirect", op: `${fd}${found}${target[1] ?? ""}`, target: null, subs: [] });
          i += target[0].length;
          continue;
        }
      }
      pending = { op: `${fd}${found}`, isHeredoc: found === "<<" || found === "<<-", isTabbed: found === "<<-" };
    } else {
      const w = part();
      add(w, c, false);
      if ((c === "*" || c === "?" || c === "[") && (reading === "extended" || !w.isQuoted)) {
        w.hasGlob = true;
      }
    }
  }
  flush();
  return tokens;
}
var ENV_NAMES = ["HOME", "PWD", "TMPDIR", "CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR"];
var MAX_NESTING = 6;
var WRAPPERS = {
  sudo: { values: "ughpUCDrtTR" },
  doas: { values: "uC" },
  nohup: { values: "" },
  time: { values: "fo" },
  command: { values: "" },
  builtin: { values: "" },
  exec: { values: "a" },
  nice: { values: "n" },
  ionice: { values: "cnp" },
  stdbuf: { values: "ioe" },
  setsid: { values: "" },
  chronic: { values: "" },
  unbuffer: { values: "" },
  timeout: { values: "sk", long: ["--signal", "--kill-after"], positional: 1 },
  xargs: { values: "ILnPdlsEea", long: ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace", "--max-lines", "--eof"] },
  env: { values: "uCS", long: ["--unset", "--chdir", "--split-string"] },
  watch: { values: "nd", long: ["--interval"] }
};
var KEYWORDS = ["if", "then", "else", "elif", "do", "while", "until", "!", "{"];
var CLOSERS = ["fi", "done", "esac", "}", "for", "case", "in", "function", "select"];
var SHELLS = ["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"];
var INTERPRETERS = {
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  nodejs: ["-e", "--eval"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  lua: ["-e"],
  osascript: ["-e"]
};
var GIT_VALUE_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"];
var isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text) && !word.text.startsWith("=");
var basename = (path) => path.slice(path.lastIndexOf("/") + 1);
var isPathLike = (word) => word.text !== "" && !/\s/.test(word.text) && !word.text.startsWith("-") && !word.hasExpansion;
function peel(words) {
  let rest = words;
  const wrappers = [];
  const assignments = [];
  const assigned = [];
  let cwd = null;
  let split = null;
  let isLookup = false;
  for (let guard = 0;guard < 16 && rest.length > 0; guard += 1) {
    const first = rest[0];
    if (first === undefined) {
      break;
    }
    if (isAssignment(first)) {
      assignments.push(first.text);
      assigned.push(first);
      rest = rest.slice(1);
      continue;
    }
    if (first.isQuoted || first.hasExpansion) {
      break;
    }
    if (KEYWORDS.includes(first.text)) {
      rest = rest.slice(1);
      continue;
    }
    const name = basename(first.text);
    const spec = WRAPPERS[name];
    if (spec === undefined) {
      break;
    }
    wrappers.push(name);
    let i = 1;
    let positional = spec.positional ?? 0;
    for (;i < rest.length; i += 1) {
      const text = rest[i]?.text ?? "";
      if (text === "--") {
        i += 1;
        break;
      }
      if (name === "env" && isAssignment(rest[i])) {
        assignments.push(text);
        assigned.push(rest[i]);
        continue;
      }
      if (text.startsWith("--")) {
        const [flag, value] = text.split("=", 2);
        if (name === "env" && flag === "--chdir") {
          cwd = value ?? rest[i + 1]?.text ?? null;
        }
        if (name === "env" && flag === "--split-string") {
          split = value ?? rest[i + 1]?.text ?? null;
        }
        if (value === undefined && (spec.long ?? []).includes(flag ?? "")) {
          i += 1;
        }
        continue;
      }
      if (text.startsWith("-") && text.length > 1) {
        const letter = text.slice(-1);
        if (name === "command" && /[vV]/.test(text)) {
          isLookup = true;
        }
        if (spec.values.includes(letter) && text.length === 2) {
          if (name === "env" && letter === "C") {
            cwd = rest[i + 1]?.text ?? null;
          }
          if (name === "env" && letter === "S") {
            split = rest[i + 1]?.text ?? null;
          }
          i += 1;
        } else if (name === "env" && text.startsWith("-S")) {
          split = text.slice(2);
        }
        continue;
      }
      if (positional > 0) {
        positional -= 1;
        continue;
      }
      break;
    }
    rest = rest.slice(i);
  }
  return { rest, wrappers, assignments, assigned, cwd, split, isLookup };
}
function assignedOf(word) {
  const at = word.text.indexOf("=");
  const name = word.text.slice(0, at).replace(/\+$/, "");
  return { name, value: word.text.slice(at + 1), isComputed: word.hasExpansion || word.text[at - 1] === "+" };
}
function gitSub(args) {
  let dir = null;
  for (let i = 0;i < args.length; i += 1) {
    const text = args[i]?.text ?? "";
    if (GIT_VALUE_OPTIONS.includes(text)) {
      if (text === "-C") {
        const next = args[i + 1]?.text ?? ".";
        dir = dir === null || next.startsWith("/") ? next : `${dir}/${next}`;
      }
      i += 1;
    } else if (text.startsWith("-")) {
      continue;
    } else {
      return { sub: text, at: i, dir };
    }
  }
  return { sub: null, at: args.length, dir };
}
var GIT_VALUE_WORD = /^(?:-[a-zA-Z]*[mFo]|--message|--file|--push-option|--template|--reuse-message|--reedit-message|--ref)$/;
function gitOptionWords(words) {
  const out = [];
  for (let i = 0;i < words.length; i += 1) {
    const word = words[i];
    if (word.text === "--") {
      break;
    }
    if (!word.text.startsWith("-") || word.text === "-" || /\s/.test(word.text)) {
      continue;
    }
    out.push(word);
    if (GIT_VALUE_WORD.test(word.text)) {
      i += 1;
    }
  }
  return out;
}
function isGitLong(word, long) {
  const text = word.text;
  if (!text.startsWith("--") || !long.startsWith("--")) {
    return false;
  }
  const name = text.includes("=") ? text.slice(0, text.indexOf("=")) : text;
  return name === long || name.length >= 4 && long.startsWith(name);
}
function gitOption(words, long, short = null) {
  for (const word of gitOptionWords(words)) {
    if (long.some((one) => isGitLong(word, one))) {
      return word.text;
    }
    if (short !== null && /^-[A-Za-z0-9]+$/.test(word.text) && word.text.slice(1).includes(short)) {
      return word.text;
    }
  }
  return null;
}
function gitOptionExactly(words, long, short = null) {
  return gitOptionWords(words).some((word) => long.some((one) => word.text === one || word.text.startsWith(`${one}=`)) || short !== null && /^-[A-Za-z0-9]+$/.test(word.text) && word.text.slice(1).includes(short));
}
function gitOptionValues(words, long) {
  const out = [];
  for (let i = 0;i < words.length; i += 1) {
    const word = words[i];
    if (word.text === "--") {
      break;
    }
    if (!isGitLong(word, long)) {
      continue;
    }
    const at = word.text.indexOf("=");
    if (at >= 0) {
      out.push({ ...word, text: word.text.slice(at + 1) });
    } else if (words[i + 1] !== undefined) {
      out.push(words[i + 1]);
      i += 1;
    }
  }
  return out;
}
function hasGitAlias(args) {
  const { at } = gitSub(args);
  const globals = args.slice(0, at);
  return globals.some((word, i) => {
    const text = word.text;
    const value = text === "-c" || text === "--config-env" ? globals[i + 1]?.text ?? "" : text.startsWith("-c") && !text.startsWith("--") ? text.slice(2) : text.startsWith("--config-env=") ? text.slice("--config-env=".length) : "";
    return /^alias\./i.test(value);
  });
}
function operands(args, values = "", long = []) {
  const out = [];
  let isEnd = false;
  for (let i = 0;i < args.length; i += 1) {
    const word = args[i];
    const text = word.text;
    if (isEnd || word.isQuoted || !text.startsWith("-") || text === "-") {
      out.push(word);
    } else if (text === "--") {
      isEnd = true;
    } else if (text.startsWith("--")) {
      if (!text.includes("=") && long.includes(text)) {
        i += 1;
      }
    } else if (/^-[A-Za-z0-9]+$/.test(text) && values.includes(text.slice(-1))) {
      i += 1;
    }
  }
  return out;
}
function flagValue(args, short, long) {
  for (let i = 0;i < args.length; i += 1) {
    const text = args[i]?.text ?? "";
    if (long !== null && text === long) {
      return args[i + 1]?.text ?? null;
    }
    if (long !== null && text.startsWith(`${long}=`)) {
      return text.slice(long.length + 1);
    }
    if (short !== null && text === short) {
      return args[i + 1]?.text ?? null;
    }
    if (short !== null && text.startsWith(short) && !text.startsWith("--") && text.length > 2 && /^-[A-Za-z]$/.test(short)) {
      return text.slice(2);
    }
  }
  return null;
}
function hasFlag(args, letter, long = []) {
  return args.some((word) => {
    const text = word.text;
    if (word.isQuoted) {
      return false;
    }
    if (long.includes(text) || long.some((name) => text.startsWith(`${name}=`))) {
      return true;
    }
    return letter !== null && /^-[A-Za-z0-9]+$/.test(text) && text.slice(1).includes(letter);
  });
}
var READ_KNOWN = ["cat", "head", "tail", "less", "more", "wc", "nl", "od", "xxd", "strings", "file", "stat", "grep", "egrep", "fgrep", "rg", "sort", "uniq", "find", "ls", "diff", "cut", "jq"];
var JQ_FLAGS = ["-r", "-c", "-e", "-s", "-n", "-S", "-j", "-a", "-C", "-M", "--raw-output", "--compact-output", "--slurp", "--null-input", "--sort-keys", "--tab", "--exit-status", "--join-output", "--ascii-output", "--color-output", "--monochrome-output"];
function effects(program, sub, args) {
  const none = { writes: [], reads: [], isUnknown: false };
  const all = (values = "", long = []) => operands(args, values, long);
  switch (program) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred": {
      const words = all("s", ["--size", "--reference"]);
      return { ...none, writes: words, replaces: words };
    }
    case "touch":
    case "truncate":
      return { ...none, writes: all("s", ["--size", "--reference"]) };
    case "mv": {
      const target = flagValue(args, "-t", "--target-directory");
      const words = all("tS", ["--target-directory", "--suffix"]);
      return { ...none, writes: target === null ? words : [...words, literal(target)], replaces: target === null ? words.slice(0, -1) : words };
    }
    case "cp":
    case "ln":
    case "install": {
      const target = flagValue(args, "-t", "--target-directory");
      const words = all("tSmgo", ["--target-directory", "--suffix", "--mode", "--owner", "--group"]);
      const isDeep = program === "cp" && (hasFlag(args, "r", ["--recursive", "--archive"]) || hasFlag(args, "R", []) || hasFlag(args, "a", []));
      const sources = target !== null ? words : words.slice(0, -1);
      const made = program === "ln" ? target !== null ? sources.map((one) => literal(`${target}/${basename(one.text)}`)) : words.slice(-1) : [];
      const links = program === "ln" && sources.length === 1 && made[0] !== undefined ? [{ name: made[0], target: sources[0], isSymbolic: hasFlag(args, "s", ["--symbolic"]) }] : [];
      const writes = target !== null ? [literal(target)] : words.slice(-1);
      return { ...none, writes, reads: sources, ...isDeep ? { readsDeep: sources } : {}, ...program === "ln" ? { replaces: made, links } : {} };
    }
    case "chmod":
    case "chown":
    case "chgrp":
      return { ...none, writes: all().slice(1) };
    case "tee":
      return { ...none, writes: all() };
    case "dd":
      return {
        ...none,
        writes: args.filter((word) => word.text.startsWith("of=")).map((word) => ({ ...word, text: word.text.slice(3) })),
        reads: args.filter((word) => word.text.startsWith("if=")).map((word) => ({ ...word, text: word.text.slice(3) }))
      };
    case "rsync": {
      const words = all("eTf", ["--rsh", "--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "--log-file", "--password-file", "--temp-dir", "--partial-dir", "--backup-dir", "--compare-dest", "--copy-dest", "--link-dest", "--suffix", "--chmod", "--chown", "--timeout", "--port"]);
      const sources = words.slice(0, -1).filter((one) => !/^[^/]*:/.test(one.text));
      const dest = words.slice(-1).filter((one) => !/^[^/]*:/.test(one.text));
      return { ...none, writes: dest, reads: sources, readsDeep: sources };
    }
    case "tar":
    case "bsdtar":
    case "gtar": {
      const first = args[0]?.text ?? "";
      const bundled = !first.startsWith("-") && /^[A-Za-z]+$/.test(first) ? first : "";
      const isExtract = /x/.test(bundled) || args.some((word) => /^-[A-Za-z]*x[A-Za-z]*$/.test(word.text) || word.text === "--extract" || word.text === "--get");
      const isCreate = /c/.test(bundled) || args.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text) || word.text === "--create");
      const into = flagValue(args, "-C", "--directory");
      const archive = flagValue(args, "-f", "--file");
      const files = operands(bundled === "" ? args : args.slice(1), "CfbTXIL", ["--directory", "--file", "--exclude", "--files-from", "--exclude-from", "--use-compress-program", "--transform", "--owner", "--group", "--mode"]);
      if (isExtract) {
        return { ...none, writes: into === null ? [] : [literal(into)], reads: archive === null ? [] : [literal(archive)] };
      }
      if (isCreate) {
        return { ...none, writes: archive === null || archive === "-" ? [] : [literal(archive)], reads: files, readsDeep: files };
      }
      return none;
    }
    case "sed":
    case "gsed": {
      const isInPlace = args.some((word) => !word.isQuoted && (/^-[a-zA-Z]*i/.test(word.text) || word.text.startsWith("--in-place")));
      const hasScript = args.some((word) => ["-e", "--expression", "-f", "--file"].includes(word.text) || /^-[a-zA-Z]*[ef]$/.test(word.text));
      const words = all("ef", ["--expression", "--file"]);
      const files = hasScript ? words : words.slice(1);
      return isInPlace ? { ...none, writes: files } : { ...none, reads: files };
    }
    case "perl": {
      const isInPlace = args.some((word) => !word.isQuoted && /^-[a-zA-Z]*i/.test(word.text));
      if (isInPlace) {
        return { ...none, writes: all("eE").slice(args.some((word) => /^-[a-zA-Z]*[eE]$/.test(word.text)) ? 0 : 1) };
      }
      return none;
    }
    case "awk":
    case "gawk": {
      const isInPlace = args.some((word, i) => word.text === "-i" && args[i + 1]?.text === "inplace");
      return isInPlace ? { ...none, writes: all("ivf").slice(1) } : none;
    }
    case "sort": {
      const out = flagValue(args, "-o", "--output");
      return out === null ? { ...none, reads: all("okt", ["--output", "--key", "--field-separator"]) } : { ...none, writes: [literal(out)] };
    }
    case "uniq": {
      const words = all("fsw");
      return { ...none, reads: words.slice(0, 1), writes: words.slice(1, 2) };
    }
    case "curl": {
      const out = flagValue(args, "-o", "--output");
      return { ...none, writes: out === null || out === "-" ? [] : [literal(out)], reads: curlReads(args) };
    }
    case "wget": {
      const out = flagValue(args, "-O", "--output-document");
      return out === null || out === "-" ? none : { ...none, writes: [literal(out)] };
    }
    case "patch":
      return { ...none, isUnknown: true };
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "wc":
    case "nl":
    case "od":
    case "xxd":
    case "strings":
    case "file":
    case "stat":
      return { ...none, reads: all("nc", ["--lines", "--bytes"]) };
    case "ls":
      return { ...none, reads: all("IwT", ["--ignore", "--hide", "--width", "--tabsize", "--format", "--sort", "--time", "--time-style", "--color", "--indicator-style", "--quoting-style", "--block-size"]) };
    case "diff":
      return { ...none, reads: [...all("CUIFLSWxXD", ["--label", "--exclude", "--exclude-from", "--ignore-matching-lines", "--starting-file", "--width", "--tabsize", "--ifdef", "--show-function-line", "--line-format", "--old-line-format", "--new-line-format", "--unchanged-line-format"]), ...["--from-file", "--to-file"].flatMap((name) => {
        const value = flagValue(args, null, name);
        return value === null ? [] : [literal(value)];
      })] };
    case "cut":
      return { ...none, reads: all("bcdf", ["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"]) };
    case "jq": {
      const isPlain = args.every((word) => word.isQuoted || !word.text.startsWith("-") || word.text === "-" || JQ_FLAGS.includes(word.text) || /^-[rcesnSjaCM]+$/.test(word.text));
      return isPlain ? { ...none, reads: all().slice(1) } : { ...none, isReadKnown: false };
    }
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg": {
      const hasPattern = args.some((word) => ["-e", "--regexp", "-f", "--file"].includes(word.text) || word.text.startsWith("--regexp=") || word.text.startsWith("--file="));
      const words = all("efABCmg", ["--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--glob", "--type", "--pre", "--pre-glob"]);
      const patterns = ["-f", "--file"].flatMap((flag) => {
        const value = flagValue(args, flag.length === 2 ? flag : null, flag.length === 2 ? null : flag);
        return value === null ? [] : [literal(value)];
      });
      const files = hasPattern ? words : words.slice(1);
      const isDeep = program === "rg" || hasFlag(args, "r", ["--recursive", "--dereference-recursive"]) || hasFlag(args, "R", []);
      return { ...none, reads: [...files, ...patterns], ...isDeep ? { readsDeep: files.length === 0 ? [literal(".")] : files } : {}, isUnknown: program === "rg" && hasFlag(args, null, ["--pre"]) };
    }
    case "git":
      return gitEffects(sub, args);
    default:
      return none;
  }
}
var literal = (text) => ({ text, isQuoted: false, hasExpansion: false, hasGlob: false });
var CURL_LONG = {
  "--data": "at",
  "--data-ascii": "at",
  "--data-binary": "at",
  "--json": "at",
  "--header": "at",
  "--data-urlencode": "encoded",
  "--url-query": "encoded",
  "--variable": "encoded",
  "--form": "form",
  "--data-raw": null,
  "--form-string": null,
  "--form-escape": null,
  "--head": null,
  "--url": null
};
var CURL_SHORT = { d: "at", H: "at", F: "form" };
var CURL_VALUES = "EKCbcdDFPHhmoUQreXYytzTuAw";
function curlLong(name) {
  const bare = name.startsWith("--expand-") ? `--${name.slice("--expand-".length)}` : name;
  const exact = CURL_LONG[bare];
  if (exact !== undefined) {
    return exact === null ? [] : [exact];
  }
  if (bare.length < 3) {
    return [];
  }
  const kinds = Object.entries(CURL_LONG).filter(([long]) => long.startsWith(bare)).map(([, kind]) => kind);
  return [...new Set(kinds.filter((kind) => kind !== null))];
}
function curlFiles(kind, value, isQuery) {
  const file = (text) => text === "" || text === "-" ? [] : [text];
  if (kind === "at") {
    return value.startsWith("@") ? file(value.slice(1)) : [];
  }
  if (kind === "encoded") {
    if (isQuery && value.startsWith("+")) {
      return [];
    }
    const at = value.search(/[@=]/);
    return at >= 0 && value[at] === "@" ? file(value.slice(at + 1)) : [];
  }
  const eq = value.indexOf("=");
  if (eq < 0) {
    return [];
  }
  const parts = [];
  let current = "";
  let isInQuote = false;
  for (let i = eq + 1;i < value.length; i += 1) {
    const ch = value[i];
    if (isInQuote && ch === "\\" && i + 1 < value.length) {
      current += value[i + 1];
      i += 1;
    } else if (ch === '"') {
      isInQuote = !isInQuote;
    } else if (ch === ";" && !isInQuote) {
      parts.push(current);
      current = "";
    } else {
      current += ch === "," && !isInQuote ? "\x00" : ch;
    }
  }
  parts.push(current);
  const [content = "", ...rest] = parts;
  const contentFiles = /^[@<]/.test(content) ? content.slice(1).split("\x00").flatMap(file) : [];
  const headerFiles = rest.filter((one) => /^headers=@/.test(one)).flatMap((one) => file(one.slice("headers=@".length).replace(/\u0000/g, ",")));
  return [...contentFiles, ...headerFiles];
}
function curlReads(args) {
  const out = [];
  const take = (kinds, value, isQuery) => {
    if (value === undefined || value.hasExpansion) {
      return;
    }
    for (const kind of kinds) {
      out.push(...curlFiles(kind, value.text, isQuery).map((text) => ({ ...literal(text), isQuoted: value.isQuoted })));
    }
  };
  for (let i = 0;i < args.length; i += 1) {
    const word = args[i];
    const text = word.text;
    if (word.hasExpansion || text === "--" || !text.startsWith("-") || text === "-") {
      continue;
    }
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const name = eq < 0 ? text : text.slice(0, eq);
      const kinds = curlLong(name);
      const isQuery = name !== "--" && "--url-query".startsWith(name.replace(/^--expand-/, "--"));
      if (eq >= 0) {
        take(kinds, { ...word, text: text.slice(eq + 1) }, isQuery);
      } else if (kinds.length > 0) {
        take(kinds, args[i + 1], isQuery);
        i += 1;
      }
      continue;
    }
    for (let j = 1;j < text.length; j += 1) {
      const letter = text[j];
      if (!CURL_VALUES.includes(letter)) {
        continue;
      }
      const kind = CURL_SHORT[letter];
      const rest = text.slice(j + 1);
      const value = rest === "" ? args[i + 1] : { ...word, text: rest };
      if (kind !== undefined) {
        take([kind], value, false);
      }
      if (rest === "") {
        i += 1;
      }
      break;
    }
  }
  return out;
}
var CONFIG_WRITES = ["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit"];
var CONFIG_READS = ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope", "--get-urlmatch", "--get-color", "--get-colorbool", "--name-only"];
function gitEffects(sub, args) {
  const { at } = gitSub(args);
  const rest = args.slice(at + 1);
  const none = { writes: [], reads: [], isUnknown: false };
  if (hasGitAlias(args)) {
    return { ...none, isUnknown: true };
  }
  switch (sub) {
    case "checkout": {
      const dash = rest.findIndex((word) => word.text === "--");
      if (dash >= 0) {
        return { ...none, writes: operands(rest.slice(dash + 1)) };
      }
      const words = operands(rest, "bB", ["--orphan"]);
      if (gitOptionExactly(rest, ["--orphan"], "b") || gitOptionExactly(rest, [], "B")) {
        return none;
      }
      if (words.length === 1) {
        const only = words[0];
        return only.text === "." || only.hasGlob ? { ...none, writes: words } : { ...none, maybe: words };
      }
      return { ...none, writes: words.slice(1) };
    }
    case "restore":
      return gitOptionExactly(rest, ["--staged"], "S") && gitOption(rest, ["--worktree"], "W") === null ? none : { ...none, writes: operands(rest, "s", ["--source"]) };
    case "rm":
      return gitOptionExactly(rest, ["--cached"]) ? none : { ...none, writes: operands(rest) };
    case "mv":
      return { ...none, writes: operands(rest) };
    case "reset":
      return gitOption(rest, ["--hard", "--merge", "--keep"]) !== null ? { ...none, writes: [literal(".")] } : none;
    case "clean":
      return gitOption(rest, ["--force"], "f") !== null && !gitOptionExactly(rest, ["--dry-run"], "n") ? { ...none, writes: operands(rest, "e", ["--exclude"]).length > 0 ? operands(rest, "e", ["--exclude"]) : [literal(".")] } : none;
    case "apply":
    case "am":
      return gitOptionExactly(rest, ["--check", "--stat", "--numstat", "--summary"]) && gitOption(rest, ["--apply"]) === null ? none : { ...none, isUnknown: true };
    case "stash": {
      const action = operands(rest)[0]?.text ?? "push";
      return ["pop", "apply"].includes(action) ? { ...none, isUnknown: true } : none;
    }
    case "config": {
      const said = operands(rest, "ft", ["--file", "--blob", "--type", "--default", "--comment", "--value"]);
      const action = said[0]?.text ?? "";
      const isWrite = gitOption(rest, CONFIG_WRITES, "e") !== null || ["set", "unset", "rename-section", "remove-section", "edit"].includes(action);
      const isRead = !isWrite && (gitOptionExactly(rest, CONFIG_READS, "l") || ["get", "list", "get-color", "get-colorbool"].includes(action) || said.length <= 1);
      if (isRead) {
        return none;
      }
      const file = gitOptionValues(rest, "--file")[0]?.text ?? flagValue(rest, "-f", null);
      return { ...none, writes: [literal(file ?? (gitOption(rest, ["--global"]) !== null ? "~/.gitconfig" : ".git/config"))] };
    }
    case "diff":
    case "log":
    case "show":
    case "format-patch": {
      const long = [...gitOptionValues(rest, "--output"), ...gitOptionValues(rest, "--output-directory")];
      const short = sub === "format-patch" ? flagValue(rest, "-o", null) : null;
      const outs = [...new Set([...long.map((word) => word.text), ...short === null ? [] : [short]])];
      return outs.length === 0 ? none : { ...none, writes: outs.map(literal) };
    }
    default:
      return none;
  }
}
var URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[^\]\s]+\]|[^\s/:'"?#)]+)/gi;
var SCP_HOST = /^[\w.+-]+@([a-z0-9][a-z0-9.-]*)(?=:)/i;
var HOST_WORD = /^(?:[\w.+-]+@)?(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[^\s]*)?$/i;
var IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/;
var cleanHost = (host) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
var NC = { short: "eIiMmOPpqsTVWwxX", long: [] };
var NETWORK = {
  curl: {
    short: "AbcCdDeEFHKmorTuUwxXyYz",
    long: ["--output", "--header", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--user", "--request", "--user-agent", "--referer", "--upload-file", "--form", "--cookie", "--cookie-jar", "--config", "--max-time", "--range", "--write-out", "--proxy", "--cert", "--key", "--connect-timeout", "--retry"]
  },
  wget: {
    short: "aBeiOoPtTUw",
    long: ["--output-document", "--output-file", "--directory-prefix", "--user-agent", "--header", "--tries", "--timeout", "--wait", "--input-file", "--base", "--post-data", "--post-file", "--user", "--password"]
  },
  ssh: { short: "BbcDEeFIiJLlmOoPpQRSWw", long: [] },
  scp: { short: "cDFiJloPSX", long: [] },
  sftp: { short: "BbcDFiJloPRSs", long: [] },
  rsync: { short: "e", long: ["--rsh", "--exclude", "--include", "--filter"] },
  nc: NC,
  ncat: NC,
  netcat: NC,
  telnet: { short: "bel", long: [] }
};
var TEXT_TOOLS = ["grep", "egrep", "fgrep", "rg", "echo", "printf", "sed", "awk", "jq", "cat", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "tee", "diff"];
var GIT_TEXT = ["commit", "tag", "log", "show", "grep", "notes", "diff", "blame", "stash"];
function hostsOf(program, args) {
  const hosts = new Set;
  if (program !== null && (TEXT_TOOLS.includes(program) || program === "git" && GIT_TEXT.includes(gitSub(args).sub ?? ""))) {
    return [];
  }
  const words = args.filter((word) => !/\s/.test(word.text));
  for (const word of words) {
    for (const match of word.text.matchAll(URL_HOST)) {
      hosts.add(cleanHost(match[1] ?? ""));
    }
    const remote = SCP_HOST.exec(word.text.replace(/^[^=]*=/, ""));
    if (remote !== null) {
      hosts.add(cleanHost(remote[1] ?? ""));
    }
  }
  const flags = program === null ? undefined : NETWORK[program];
  if (program !== null && flags !== undefined) {
    const positional = operands(args, flags.short, flags.long).map((word) => word.text).filter((text) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(text));
    const named = ["ssh", "nc", "ncat", "netcat", "telnet"].includes(program) ? positional.slice(0, 1) : ["scp", "sftp", "rsync"].includes(program) ? positional.filter((text) => text.includes(":") || program === "sftp") : positional.filter((text) => /\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(text) || /^localhost\b/i.test(text) || IPV4.test(text));
    for (const text of named) {
      const host = HOST_WORD.exec(text.replace(/\/.*$/, ""))?.[1];
      if (host !== undefined) {
        hosts.add(cleanHost(host));
      }
    }
  }
  hosts.delete("");
  return [...hosts];
}
function pathsInCode(code) {
  const found = new Set;
  for (const match of code.matchAll(/["'`]([^"'`\s]+)["'`]|(?:^|[\s(,=])((?:\.{0,2}\/|~\/)?[\w.-]+(?:\/[\w.*-]+)+|\.[\w.-]+|[\w-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),;])/g)) {
    const text = match[1] ?? match[2];
    if (text !== undefined && text !== "") {
      found.add(text);
    }
  }
  return [...found];
}
function findRoots(args) {
  const end = args.findIndex((word) => word.text === "(" || word.text === "!" || !word.isQuoted && word.text.startsWith("-"));
  const roots = args.slice(0, end < 0 ? args.length : end);
  return roots.length > 0 ? roots : [literal(".")];
}
var FIND_FILTERS = ["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename"];
function findFilters(args, roots) {
  const expression = args.slice(args.indexOf(roots[roots.length - 1]) + 1);
  if (expression.some((word) => word.text === "!" || !word.isQuoted && ["-not", "-regex", "-iregex"].includes(word.text))) {
    return null;
  }
  const branches = [[]];
  for (const word of expression) {
    if (!word.isQuoted && ["-o", "-or", ","].includes(word.text)) {
      branches.push([]);
    } else {
      branches[branches.length - 1]?.push(word);
    }
  }
  if (!branches.every((branch) => branch.some((word) => !word.isQuoted && FIND_FILTERS.includes(word.text)))) {
    return null;
  }
  const globs = [];
  for (let i = 0;i < expression.length; i += 1) {
    const flag = expression[i];
    const value = expression[i + 1];
    if (flag.isQuoted || !FIND_FILTERS.includes(flag.text) || value === undefined || value.hasExpansion) {
      continue;
    }
    for (const root of roots) {
      const base = root.text.replace(/\/+$/, "") || "/";
      const text = flag.text.endsWith("name") && !flag.text.endsWith("wholename") ? `${base}/**/${value.text}` : value.text.startsWith(`${base}/`) ? value.text.replace(/\*+/g, "**") : `${base}/${value.text.replace(/\*+/g, "**").replace(/^\/+/, "")}`;
      globs.push({ text, isQuoted: false, hasExpansion: false, hasGlob: true });
    }
    i += 1;
  }
  return globs.length > 0 ? globs : null;
}
var TEST_RUNNERS = ["pytest", "py.test", "jest", "vitest", "mocha", "ava", "phpunit", "rspec", "tox", "nox", "ctest", "bats", "karma", "playwright"];
var TEST_MODULES = ["pytest", "unittest", "nose2", "tox", "nox"];
function inlineCode(program, args) {
  const flags = INTERPRETERS[program] ?? INTERPRETERS[program.replace(/[0-9.]+$/, "")];
  if (flags === undefined) {
    return -1;
  }
  return args.findIndex((word) => !word.isQuoted && (flags.includes(word.text) || /^-[a-zA-Z]+$/.test(word.text) && flags.some((flag) => flag.length === 2 && word.text.endsWith(flag.slice(1)))));
}
function movePattern(target, at, home, isPushd) {
  if (!target.hasGlob && !isPushd || target.hasExpansion) {
    return null;
  }
  const glob = target.template ?? target.text;
  const spelled = glob === "~" || glob.startsWith("~/") ? home === null ? null : `${home}${glob.slice(1)}` : glob.startsWith("~") ? null : glob;
  const abs = spelled === null ? null : spelled.startsWith("/") ? spelled : at === null || !at.startsWith("/") ? null : `${at}/${spelled}`;
  return abs === null ? null : `${abs.replace(/\/+$/, "")}/`;
}
function moveTarget(program, args) {
  if (program === "cd") {
    return operands(args)[0];
  }
  if (program !== "pushd") {
    return;
  }
  const word = args.length === 1 ? args[0] : args.length === 2 && args[0]?.text === "--" ? args[1] : undefined;
  return word === undefined || word.text === "" || (args.length === 1 ? /^[-+]/.test(word.text) : word.text === "-") ? undefined : word;
}
var DECLARERS = ["export", "declare", "typeset", "readonly", "local"];
function expandWord(word, value, isAssigning) {
  const template = word.template;
  if (template === undefined || template === "" || !hasMarker(template) && (isAssigning || !holds(template, "{"))) {
    return [word];
  }
  const resolved = hasMarker(template) ? resolveTemplate(template, value) : template;
  if (resolved === null && (isAssigning || !holds(template, "{"))) {
    return [word];
  }
  const alternatives = isAssigning ? [resolved ?? template] : braceExpand(resolved ?? template);
  if (alternatives === null) {
    return [{ ...word, isCapped: true }];
  }
  return alternatives.map((one) => {
    const isOpen = resolved === null && hasMarker(one);
    return {
      text: templateText(one),
      isQuoted: word.isQuoted,
      hasExpansion: isOpen,
      hasGlob: isGlobTemplate(one) || isOpen && word.hasGlob,
      template: one,
      ...isOpen ? { lead: word.lead ?? null } : {}
    };
  });
}
function build(text, cwd, depth, counter, isNested, vars) {
  const segments = [];
  let pipeline = counter.next;
  counter.next += 1;
  let place = 0;
  const scopes = [];
  let at = cwd;
  let dirs = [];
  let words = [];
  let redirects = [];
  let subs = [];
  const tildeHere = (word) => {
    if (vars.reading === "reviewed" || at === null || !at.startsWith("/") || word.hasExpansion || !/^~\+(?:\/|$)/.test(word.text)) {
      return word;
    }
    const template = word.template === undefined ? undefined : `${[...at].map((c) => encode(c, true)).join("")}${word.template.slice(2)}`;
    return { ...word, text: `${at}${word.text.slice(2)}`, ...template === undefined ? {} : { template } };
  };
  const valueOf = (name) => {
    if (vars.line.has(name)) {
      return vars.line.get(name) ?? null;
    }
    if (name === "PWD" && at !== null && at.startsWith("/")) {
      return at;
    }
    if (!ENV_NAMES.includes(name)) {
      return null;
    }
    const found = vars.env[name];
    return found === undefined || found === null || found === "" ? null : found;
  };
  const setVar = (name, value) => {
    const known = vars.line.get(name);
    vars.line.set(name, vars.line.has(name) && known !== value ? null : value);
  };
  const nested = (code, from, inline = []) => {
    if (depth < MAX_NESTING) {
      const line = new Map(vars.line);
      for (const one of inline) {
        line.set(one.name, one.isComputed ? null : one.value);
      }
      segments.push(...build(code, from ?? cwd, depth + 1, counter, true, { line, env: vars.env, globs: vars.globs, reading: vars.reading }));
      return;
    }
    const words = tokenize(code, vars.reading).flatMap((token) => token.kind === "word" ? [token.word] : []);
    segments.push({
      words,
      wrappers: [],
      assignments: [],
      assigned: [],
      program: null,
      args: [],
      sub: null,
      redirects: [],
      writes: [],
      isWriteOpen: true,
      maybeWrites: [],
      reads: [],
      isReadKnown: false,
      readsDeep: [],
      replaces: [],
      links: [],
      capped: [],
      hosts: [],
      isUnknown: true,
      named: [...new Set([...words.filter(isPathLike).map((word) => word.text.replace(/^[^=]*=/, "")), ...pathsInCode(code)])].filter((path) => path !== ""),
      cwd: from ?? cwd,
      moveGlob: null,
      pipeline: counter.next,
      place: 0,
      isNested: true,
      isFedByInput: false,
      isBeyondDepth: true
    });
    counter.next += 1;
  };
  const fresh = () => {
    pipeline = counter.next;
    counter.next += 1;
    place = 0;
  };
  const close = () => {
    for (const sub of subs) {
      nested(sub, at);
    }
    subs = [];
    if (words.length === 0 && redirects.length === 0) {
      return;
    }
    const expanded = words.flatMap((word) => expandWord(tildeHere(word), valueOf, isAssignment(word)));
    const peeled = peel(expanded);
    const rest = peeled.isLookup ? [] : peeled.rest;
    const head = rest[0];
    const args = rest.slice(1);
    let program = null;
    let isUnknown = false;
    const named = [];
    if (head !== undefined && !CLOSERS.includes(head.text)) {
      if (head.hasExpansion) {
        const runner = basename(head.text);
        if (TEST_RUNNERS.includes(runner)) {
          program = runner;
        } else if (!(args[0]?.text === "-m" && TEST_MODULES.includes(args[1]?.text ?? ""))) {
          isUnknown = true;
        }
      } else {
        program = basename(head.text);
      }
    }
    const assigned = peeled.assigned.map(assignedOf);
    const moved = peeled.cwd;
    let segCwd = moved === null ? at : moved.startsWith("/") ? moved : at === null ? null : `${at}/${moved}`;
    let sub = null;
    if (program === "git") {
      const found = gitSub(args);
      sub = found.sub;
      if (found.dir !== null) {
        segCwd = found.dir.startsWith("/") ? found.dir : segCwd === null ? null : `${segCwd}/${found.dir}`;
      }
    } else {
      sub = operands(args)[0]?.text ?? null;
    }
    if (peeled.split !== null) {
      nested(peeled.split, segCwd, assigned);
    }
    if (program !== null && SHELLS.includes(program)) {
      const flag = args.findIndex((word) => !word.isQuoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text));
      const script = flag >= 0 ? args[flag + 1] : undefined;
      if (script !== undefined) {
        isUnknown ||= script.hasExpansion;
        nested(script.text, segCwd, assigned);
      }
    }
    if (program === "eval") {
      isUnknown = true;
      nested(args.map((word) => word.text).join(" "), segCwd, assigned);
    }
    if (program !== null) {
      const flag = inlineCode(program, args);
      if (flag >= 0) {
        isUnknown = true;
        named.push(...pathsInCode(args[flag + 1]?.text ?? ""));
      }
    }
    let writes = [];
    let reads = [];
    let maybe = [];
    let isReadKnown = program !== null && READ_KNOWN.includes(program);
    let readsDeep = [];
    let replaces = [];
    let links = [];
    if (program !== null) {
      const found = effects(program, sub, args);
      writes = found.writes;
      reads = found.reads;
      maybe = found.maybe ?? [];
      isUnknown ||= found.isUnknown;
      isReadKnown &&= found.isReadKnown !== false;
      readsDeep = found.readsDeep ?? [];
      replaces = found.replaces ?? [];
      links = found.links ?? [];
    }
    if (program === "curl") {
      named.push(...reads.filter((word) => !word.hasExpansion).map((word) => word.text));
    }
    if (program === "find") {
      const roots = findRoots(args);
      const filtered = findFilters(args, roots);
      reads = roots;
      for (let i = 0;i < args.length; i += 1) {
        const flag = args[i]?.text ?? "";
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(flag)) {
          const end = args.findIndex((word, j) => j > i && (word.text === ";" || word.text === "+"));
          const body = args.slice(i + 1, end < 0 ? args.length : end);
          for (const found of filtered ?? roots) {
            const path = filtered === null ? found.text : `'${found.text}'`;
            nested(body.map((word) => word.text === "{}" ? path : /[\s'"]/.test(word.text) ? `'${word.text.replace(/'/g, "")}'` : word.text).join(" "), segCwd);
          }
          i = end < 0 ? args.length : end;
        } else if (flag === "-delete") {
          writes = [...writes, ...filtered ?? roots];
        } else if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(flag) && args[i + 1] !== undefined) {
          writes = [...writes, args[i + 1]];
        }
      }
    }
    if (isUnknown) {
      named.push(...args.filter(isPathLike).map((word) => word.text.replace(/^[^=]*=/, "")));
    }
    const placedRedirects = [];
    let isWriteOpen = writes.some((word) => word.hasExpansion);
    for (const { op, target } of redirects) {
      const isHere = /<<<?-?$/.test(op);
      for (const word of target === null ? [null] : isHere ? [target] : expandWord(tildeHere(target), valueOf, false)) {
        const shown = word?.text ?? "";
        const isDescriptor = target === null;
        const isNull = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/.test(shown);
        const isPlain = !isDescriptor && !isNull && !isHere;
        placedRedirects.push({ op, target: shown, isWrite: isPlain && op.includes(">"), isRead: isPlain && op.includes("<") });
        isWriteOpen ||= isPlain && op.includes(">") && word?.hasExpansion === true;
      }
    }
    for (const one of placedRedirects) {
      if (one.isWrite) {
        writes = [...writes, literal(one.target)];
      } else if (one.isRead) {
        reads = [...reads, literal(one.target)];
      }
    }
    const isText = (word) => word.text !== "";
    const target = moveTarget(program, args);
    const home = valueOf("HOME");
    const pattern = target === undefined || vars.reading === "reviewed" ? null : movePattern(target, at, home, program === "pushd");
    segments.push({
      words: expanded,
      wrappers: peeled.wrappers,
      assignments: peeled.assignments,
      assigned,
      program,
      args,
      sub,
      redirects: placedRedirects,
      writes: writes.map((word) => word.text).filter((path) => path !== ""),
      isWriteOpen,
      maybeWrites: maybe.filter((word) => !word.hasExpansion).map((word) => word.text).filter((path) => path !== ""),
      reads: reads.filter((word) => !word.hasExpansion).map((word) => word.text).filter((path) => path !== ""),
      isReadKnown: isReadKnown && reads.every((word) => !word.hasExpansion),
      readsDeep: readsDeep.filter((word) => !word.hasExpansion && isText(word)).map((word) => word.text),
      replaces: replaces.filter((word) => !word.hasExpansion && isText(word)).map((word) => word.text),
      links: links.filter((one) => !one.name.hasExpansion && !one.target.hasExpansion && isText(one.name) && isText(one.target)).map((one) => ({ name: one.name.text, target: one.target.text, isSymbolic: one.isSymbolic })),
      capped: expanded.filter((word) => word.isCapped === true).map((word) => word.text),
      hosts: hostsOf(program, args),
      isUnknown,
      named: [...new Set(named)].filter((path) => path !== ""),
      cwd: segCwd,
      moveGlob: pattern,
      pipeline,
      place,
      isNested,
      isFedByInput: peeled.wrappers.includes("xargs")
    });
    if (program === null && head === undefined) {
      for (const one of assigned) {
        setVar(one.name, one.isComputed ? null : one.value);
      }
    } else if (program !== null && DECLARERS.includes(program)) {
      for (const word of args.filter(isAssignment)) {
        const one = assignedOf(word);
        setVar(one.name, one.isComputed ? null : one.value);
      }
    } else if (program === "unset" || program === "read" || program === "mapfile" || program === "readarray" || program === "getopts") {
      for (const word of operands(args, program === "read" ? "adinNpt" : "dnOsuCc")) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) {
          vars.line.set(word.text, null);
        }
      }
    }
    if (vars.reading === "reviewed") {
      if (program === "cd") {
        const text = target === undefined ? "~" : target.text;
        const spelled = target !== undefined && target.hasExpansion ? null : text === "~" || text.startsWith("~/") ? home === null ? null : `${home}${text.slice(1)}` : text;
        at = spelled === null || spelled === "-" || spelled.startsWith("~") ? null : spelled.startsWith("/") ? spelled : at === null ? null : `${at}/${spelled}`;
      }
    } else if (program === "popd") {
      if (args.length === 0 && dirs.length > 0) {
        at = dirs.pop() ?? null;
      }
    } else if (program === "pushd") {
      const matched = pattern === null ? undefined : vars.globs?.[pattern];
      const found = Array.isArray(matched) && matched.length === 1 ? matched[0] : undefined;
      if (found !== undefined) {
        dirs.push(at);
        at = found;
      }
    } else if (program === "cd") {
      const text = target === undefined ? "~" : target.text;
      const matched = pattern === null ? undefined : vars.globs?.[pattern];
      const spelled = target !== undefined && target.hasExpansion ? null : target !== undefined && target.hasGlob ? Array.isArray(matched) && matched.length === 1 ? matched[0] ?? null : null : text === "~" || text.startsWith("~/") ? home === null ? null : `${home}${text.slice(1)}` : text;
      const to = spelled === null || spelled === "-" || spelled.startsWith("~") ? null : spelled.startsWith("/") ? spelled : at === null ? null : `${at}/${spelled}`;
      at = to;
    }
    words = [];
    redirects = [];
    place += 1;
  };
  for (const token of tokenize(text, vars.reading)) {
    if (token.kind === "word") {
      words.push(token.word);
      subs.push(...token.subs);
    } else if (token.kind === "redirect") {
      subs.push(...token.subs);
      redirects.push({ op: token.op, target: token.target });
    } else {
      close();
      if (token.op === "(") {
        scopes.push({ at, dirs: [...dirs] });
      } else if (token.op === ")") {
        const scope = scopes.pop();
        if (scope !== undefined) {
          at = scope.at;
          dirs = scope.dirs;
        }
      }
      if (token.op !== "|" && token.op !== "|&") {
        fresh();
      }
    }
  }
  close();
  return segments;
}
function parse(command, reading, cwd = ".", env = {}, globs) {
  return build(command, cwd, 0, { next: 0 }, false, { line: new Map, env, globs, reading });
}
function readings(command, cwd = ".", env = {}, globs) {
  return READINGS.map((reading) => parse(command, reading, cwd, env, globs));
}
function view(segment, isPeeled) {
  const words = isPeeled ? segment.program === null ? [] : [{ text: segment.program }, ...segment.args] : segment.words;
  const shown = words.map((word) => word.isQuoted && /\s/.test(word.text) ? '"…"' : word.text);
  return shown.join(" ");
}
function assignedBefore(name, earlier) {
  const values = [];
  for (const segment of earlier) {
    const declared = segment.program !== null && DECLARERS.includes(segment.program) ? segment.args.filter(isAssignment).map(assignedOf) : [];
    for (const one of [...segment.assigned, ...declared]) {
      if (one.name === name) {
        values.push(one);
      }
    }
  }
  return values;
}

// hooks/tasks.ts
var TASKS_DIR = ".tasks";
var TASKS_OFF = { isOn: false, canFinish: null, finishWhy: "" };
var isVersion2 = (configText) => configText !== null && /^version:\s*["']?2["']?\s*(#.*)?$/m.test(configText);
var RESOLVING = ["done", "cancel"];
var isTasksName = (text) => /^(?:@speekl\/tasks|tasks)(?:@[^\s/]+)?$/.test(text);
var RUNNER_VALUES = {
  npx: { short: "pc", long: ["--package", "--call", "--cache", "--userconfig"] },
  bunx: { short: "p", long: ["--package", "--bun"] },
  pnpm: { short: "C", long: ["--dir", "--filter", "--package"] },
  yarn: { short: "", long: ["--cwd", "--package"] },
  npm: { short: "pc", long: ["--package", "--call", "--prefix", "--workspace"] }
};
function tasksArgs(segment) {
  if (segment.program !== null && isTasksName(segment.program)) {
    return segment.args;
  }
  const runner = segment.program === null ? undefined : RUNNER_VALUES[segment.program];
  if (runner === undefined || segment.program === null) {
    return null;
  }
  let args = segment.args;
  if (segment.program === "pnpm" || segment.program === "yarn" || segment.program === "npm") {
    const verb = operands(args, runner.short, runner.long)[0];
    if (verb === undefined || !["exec", "dlx", "x"].includes(verb.text)) {
      return null;
    }
    args = args.slice(args.indexOf(verb) + 1);
  }
  const named = operands(args, runner.short, runner.long).filter((word) => word.text !== "--");
  const head = named[0];
  if (head === undefined || !isTasksName(head.text)) {
    return null;
  }
  return args.slice(args.indexOf(head) + 1);
}
function tasksAction(segment) {
  const args = tasksArgs(segment);
  if (args === null) {
    return null;
  }
  const said = operands(args, "Cm", ["--as", "--session", "--message", "--actor"]);
  return { action: said[0]?.text ?? null, next: said[1]?.text ?? null };
}
var taskOf = (segment) => {
  const said = operands(tasksArgs(segment) ?? segment.args, "Cm", ["--as", "--session", "--message", "--actor"]);
  return said[1]?.text ?? "<task>";
};
var handoffCommand = (task) => `tasks handoff <person> ${task} -m "<what is done, what the person must check>"`;
function tasksRefusalsIn(segments, facts) {
  if (!facts.isOn) {
    return [];
  }
  const out = [];
  for (const [i, segment] of segments.entries()) {
    const one = tasksAction(segment);
    const args = tasksArgs(segment);
    if (one === null || args === null) {
      continue;
    }
    if (hasFlag(args, null, ["--force"])) {
      out.push({ rule: "tasks", reason: "`tasks --force` overrides the convention's authorization, its start gate and a live claim: that is a person's call. Run the command without it; if it is refused, say why and leave it to the person." });
    }
    const as = flagValue(args, null, "--as");
    const earlier = assignedBefore("TASKS_ACTOR", segments.slice(0, i));
    const actor = segment.assignments.find((word) => word.startsWith("TASKS_ACTOR=")) ?? (earlier[0] === undefined ? undefined : `TASKS_ACTOR=${earlier[0].isComputed ? "…" : earlier[0].value}`);
    if (as !== null || actor !== undefined) {
      out.push({ rule: "tasks", reason: `Acting as another actor (${as !== null ? `--as ${as}` : actor ?? ""}) is the person's to do: run the command as yourself, or hand the task over with \`${handoffCommand(taskOf(segment))}\`.` });
    }
    if (one.action !== null && RESOLVING.includes(one.action) && facts.canFinish !== true) {
      out.push({
        rule: "tasks",
        reason: `\`tasks ${one.action}\` resolves a task, and devloop's gate is the finish gate: ${facts.canFinish === false ? facts.finishWhy || "the gate is not green on this tree, or the change needs a person's approval" : "the harness could not prove the gate here"}. Hand the task to a person instead: \`${handoffCommand(taskOf(segment))}\`.`
      });
    }
  }
  return out;
}
var isTaskFile = (rel) => /^\.tasks\/(?:[^/]+\/)*task\.md$/.test(rel);
var isTaskLog = (rel) => /^\.tasks\/(?:[^/]+\/)*log\.md$/.test(rel);
var isTreeFile = (rel) => rel === ".tasks/config.yml" || rel === ".tasks/index.md" || rel === ".tasks/.locks" || rel.startsWith(".tasks/.locks/");
function frontmatterOf(text) {
  const lines = text.replace(/\r\n/g, `
`).split(`
`);
  if (lines[0]?.trim() !== "---") {
    return null;
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end < 0 ? null : lines.slice(1, end).join(`
`);
}
function tasksEditRefusal(rel, before, after, facts) {
  if (!facts.isOn || !rel.startsWith(`${TASKS_DIR}/`)) {
    return null;
  }
  if (isTaskLog(rel)) {
    return { rule: "tasks", reason: `${rel} is a task's log: the \`tasks\` command appends to it with each transition and note, and nothing else writes it. Use \`tasks note <task> -m "…"\` or the transition itself.` };
  }
  if (isTreeFile(rel)) {
    return { rule: "tasks", reason: `${rel} belongs to the task tree itself (its configuration, locks or derived index): a person edits the configuration; the command keeps the rest.` };
  }
  if (isTaskFile(rel) && (after === null || frontmatterOf(before ?? "") !== frontmatterOf(after))) {
    return { rule: "tasks", reason: `This edit changes ${rel}'s frontmatter (between the --- fences), which the \`tasks\` command owns: use \`tasks claim|pause|release|handoff|priority|assign <task>\` for status, claim and assignment. The body below the fences is yours to edit.` };
  }
  return null;
}
function tasksEditRefusalOf(placed, before, after, facts) {
  for (const one of placed) {
    const refusal = one.rel === null || one.rel === "" ? null : tasksEditRefusal(one.rel, before, after, facts);
    if (refusal !== null) {
      return refusal;
    }
  }
  return null;
}
var TASKS_LOCKED = [`${TASKS_DIR}/**/task.md`, `${TASKS_DIR}/**/log.md`, `${TASKS_DIR}/config.yml`, `${TASKS_DIR}/index.md`, `${TASKS_DIR}/.locks/**`];
var isTasksLocked = (rel) => isTaskLog(rel) || isTaskFile(rel) || isTreeFile(rel);
function tasksShellWriteRefusal(rel, facts, where = { filesUnder: {}, folders: {} }) {
  if (!facts.isOn) {
    return null;
  }
  const refuse = (named) => ({
    rule: "tasks",
    reason: `${named} is written by the \`tasks\` command (a manifest's frontmatter, a log, the tree's own files), and a shell write cannot be told apart from a change to its state. Use the command (\`tasks state|note|<transition> <task>\`), or the edit tool for a task's body.`
  });
  const { dir, within } = globParts(rel);
  if (within === "" && isTasksLocked(rel)) {
    return refuse(rel);
  }
  const isFolder = within !== "" || where.folders[dir] !== false;
  const isNear = dir === "" || dir === TASKS_DIR || dir.startsWith(`${TASKS_DIR}/`);
  if (!isFolder || !isNear) {
    return null;
  }
  const reached = lockedBeneath(dir, within, TASKS_LOCKED, where.filesUnder[dir] ?? []).find((one) => isTasksLocked(one.path));
  return reached === undefined ? null : refuse(reached.label);
}
var isTaskStatePath = (path) => path.startsWith(`${TASKS_DIR}/`) && /\.(?:md|ya?ml)$/.test(path) && !path.split("/").includes("..");
var isTaskStateOnly = (paths) => paths.length > 0 && paths.every(isTaskStatePath);
function sessionCheckProblems(code, out) {
  if (code === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(out);
    const lines = (parsed.violations ?? []).slice(0, 6).map((one) => `${one.task ?? one.id ?? "?"}${one.reason ?? one.message ? `: ${one.reason ?? one.message ?? ""}` : ""}`);
    if (lines.length > 0) {
      return lines.join("; ");
    }
  } catch {}
  const said = out.split(`
`).map((line) => line.trim()).filter((line) => line !== "").slice(0, 4).join(" ");
  return said === "" ? `exit ${code}` : said.slice(0, 400);
}

// hooks/rules.ts
function normalize(path) {
  const isAbsolute = path.startsWith("/");
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
    } else if (part !== ".." || !isAbsolute) {
      out.push(part);
    }
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}
function relative(root, cwd, path) {
  const base = normalize(root);
  const full = normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  if (full === base) {
    return "";
  }
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null;
}
var cache2 = new Map;
function compile(glob, isFolded = false) {
  const key = `${isFolded ? "i" : ""}:${glob}`;
  const known = cache2.get(key);
  if (known !== undefined) {
    return known;
  }
  let source = "";
  for (let i = 0;i < glob.length; i += 1) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "[" && classEnd(glob, i) > 0) {
      const end = classEnd(glob, i);
      const body = glob.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&");
      source += negated ? `[^/${members}]` : `(?![/])[${members}]`;
      i = end;
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const made = new RegExp(`^${source}$`, isFolded ? "i" : "");
  cache2.set(key, made);
  return made;
}
function classEnd(glob, at) {
  let i = at + 1;
  if (glob[i] === "!" || glob[i] === "^") {
    i += 1;
  }
  if (glob[i] === "]") {
    i += 1;
  }
  for (;i < glob.length; i += 1) {
    if (glob[i] === "/") {
      return -1;
    }
    if (glob[i] === "]") {
      return i;
    }
  }
  return -1;
}
function matches(path, glob, isFolded = false) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return compile(glob, isFolded).test(path) || !glob.includes("/") && compile(glob, isFolded).test(name);
}
var matchesAny = (path, globs, isFolded = false) => globs.some((glob) => matches(path, glob, isFolded));
var isSecret = (path, cfg) => matchesAny(path, BUILTIN_SECRETS, true) || matchesAny(path, cfg.secrets, true) && !matchesAny(path, cfg.secretsAllow, true);
var envOf = (where) => ({ ...where.env ?? {}, HOME: where.home, TMPDIR: where.tmp });
var parseOf = (command, where, reading) => parse(command, reading, where.cwd, envOf(where), reading === "extended" ? where.globsExtended : undefined);
function unionBy(items, key) {
  const seen = new Set;
  return items.filter((item) => {
    const one = key(item);
    if (seen.has(one)) {
      return false;
    }
    seen.add(one);
    return true;
  });
}
var unionPlaces = (places) => unionBy(places, (one) => JSON.stringify([one.spelled, one.abs, one.raw ?? null, one.isMatch === true]));
var whereOf = (root, cwd = root, more = {}) => ({ root, cwd, home: null, tmp: null, stateRoot: null, filesUnder: {}, folders: {}, savedOutput: () => null, branch: null, sandbox: null, ...more });
function place(spelled, cwd, where) {
  let abs = null;
  if (spelled === "~" || spelled.startsWith("~/")) {
    abs = where.home === null ? null : normalize(`${where.home}${spelled.slice(1)}`);
  } else if (spelled.startsWith("/")) {
    abs = normalize(spelled);
  } else if (!spelled.startsWith("~") && cwd !== null) {
    abs = normalize(`${cwd.startsWith("/") ? cwd : `${where.cwd}/${cwd}`}/${spelled}`);
  }
  const joined = abs === null ? null : spelled.startsWith("/") ? spelled : spelled.startsWith("~") ? `${where.home ?? ""}${spelled.slice(1)}` : `${cwd !== null && cwd.startsWith("/") ? cwd : `${where.cwd}/${cwd ?? ""}`}/${spelled}`;
  const raw = joined !== null && /(?:^|\/)(?!\.\.?(?:\/|$))[^/]+\/(?:\.?\/)*\.\.(?:\/|$)/.test(joined) ? joined : undefined;
  return { spelled, abs, rel: abs === null ? null : relative(where.root, where.root, abs), ...raw === undefined ? {} : { raw } };
}
function physicalPath(raw, real) {
  let at = "";
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      const resolved = at === "" ? "/" : real(at) ?? at;
      at = resolved === "/" ? "" : resolved.slice(0, resolved.lastIndexOf("/"));
    } else {
      at = `${at}/${part}`;
    }
  }
  return at === "" ? "/" : at;
}
function spellings(path) {
  const out = new Set;
  if (path.rel !== null && path.rel !== "") {
    out.add(path.rel);
  }
  if (path.abs !== null) {
    out.add(path.abs.replace(/^\/+/, ""));
  }
  out.add(normalize(path.spelled.replace(/^~\/?/, "")).replace(/^\/+/, ""));
  out.delete("");
  return [...out];
}
var isSecretPlace = (path, cfg) => spellings(path).some((one) => isSecret(one, cfg));
var EVAL_SANDBOX_PREFIX = "/tmp/devloop-eval-";
function sandboxOf(abs) {
  if (abs === null || !abs.startsWith(EVAL_SANDBOX_PREFIX)) {
    return null;
  }
  const cut = abs.indexOf("/", EVAL_SANDBOX_PREFIX.length);
  return cut < 0 ? abs : abs.slice(0, cut);
}
var isUnder = (abs, folders) => abs !== null && (folders ?? []).some((one) => abs === one || abs.startsWith(`${one.replace(/\/+$/, "")}/`));
var isInLibrary = (path, where) => isUnder(path.abs, where.library);
var harnessStateReason = (path, where) => where !== undefined && isInLibrary(path, where) ? `${path.spelled} is in the spec library, which only the harness writes (a person saves a spec there with /devloop library save). It is read, never written, from here.` : sandboxOf(path.abs) !== null ? `${path.spelled} is inside an eval sandbox, which is the harness's own: only the eval agent working in it writes there.` : `${path.spelled} is the harness's own record (saved check output, the review's diff). It is read, never written, from here.`;
var isHarnessState = (path, where) => {
  if (isInLibrary(path, where)) {
    return true;
  }
  if (where.stateRoot !== null && path.abs !== null && (path.abs === where.stateRoot || path.abs.startsWith(`${where.stateRoot}/`))) {
    return true;
  }
  const sandbox = sandboxOf(path.abs);
  return where.stateRoot !== null && sandbox !== null && sandbox !== where.sandbox;
};
var ALWAYS_HELD = ["secret", "harness-state", "reviewer-read-only", "budget", "eval-containment", "evidence-notes"];
var isAlwaysHeld = (rule) => ALWAYS_HELD.includes(rule);
var POLICY_RULES = ["forbidden", "egress", "content-rule"];
var NEVER_LIFTED = ["ship-alone"];
var liftOf = (rule) => rule === "budget" ? "person" : isAlwaysHeld(rule) || NEVER_LIFTED.includes(rule) ? "none" : POLICY_RULES.includes(rule) ? "policy" : "person";
function liftClause(rule) {
  const lift = liftOf(rule);
  return lift === "none" ? "(Always held: no one lifts it.)" : lift === "policy" ? "(Lifted by a change to devloop.json.)" : "(A person can lift it.)";
}
var RULES = [
  ...ALWAYS_HELD,
  "spec-locked",
  "protected",
  "tests-locked",
  "spec-first",
  "high-needs-spec",
  "test-weakened",
  "destructive",
  "production",
  "forbidden",
  "egress",
  "no-verify",
  "force-push",
  "check-filtered",
  "human-merge",
  "gate",
  "ship-alone",
  "content-rule",
  "tasks",
  "git-hidden",
  "cache-guard"
];
var isHeldBy = (rule, cfg) => isAlwaysHeld(rule) || cfg.mode === "enforce" && (rule !== "tasks" || cfg.tasks.integrate === "enforce");
var BUILTIN_INSTRUCTIONS = ["checklists/**"];
var instructionGlobs = (cfg) => [...cfg.instructions, ...BUILTIN_INSTRUCTIONS];
var strictest = (all, cfg) => all.find((one) => isAlwaysHeld(one.rule)) ?? (cfg === undefined ? undefined : all.find((one) => isHeldBy(one.rule, cfg))) ?? all[0] ?? null;
var isExempt = (path, loop) => loop.allow.some((one) => one.kind === "path" && matches(path, one.value));
function judgeEdit(path, cfg, loop, label = path, isUntracked = false) {
  if (isSecret(path, cfg)) {
    return {
      rule: "secret",
      reason: `${label} holds secrets; it is never read or written from here.`
    };
  }
  if (isExempt(path, loop)) {
    return null;
  }
  if (loop.spec !== null && path.startsWith(`specs/${loop.spec}/`)) {
    return loop.phase === "spec" ? null : {
      rule: "spec-locked",
      reason: `${label} is the approved spec. It changes only through a person: /devloop spec ${loop.spec} reopens it. To record a passing feature call the feature_check tool.`
    };
  }
  if (matchesAny(path, cfg.protected) || matchesAny(path, BUILTIN_PROTECTED)) {
    return {
      rule: "protected",
      reason: `${label} is part of the harness or its policy, which the building agent does not edit. A person can exempt it for one turn with /devloop allow ${path}.`
    };
  }
  const isTest = matchesAny(path, cfg.tests);
  const isNoTest = isUntracked && !matchesAny(path, testNameGlobs(cfg.tests)) && !(path in (loop.testHashes ?? {}));
  if (loop.phase === "build" && isTest && !loop.newTests.includes(path) && !isNoTest) {
    return {
      rule: "tests-locked",
      reason: `${label} is a test, and tests are locked while building against an approved spec: make the code pass them. If the test itself is wrong, stop and say so; a person can exempt it with /devloop allow ${path}.`
    };
  }
  if (loop.phase === "spec") {
    return isTest ? null : {
      rule: "spec-first",
      reason: `The spec for "${loop.spec ?? ""}" is not approved yet, so only the spec and its tests change. Finish specs/${loop.spec ?? ""}/SPEC.md and features.json, then ask the person to run /devloop approve.`
    };
  }
  if (loop.phase !== "build" && matchesAny(path, cfg.tiers.high)) {
    return {
      rule: "high-needs-spec",
      reason: `${label} is a high-risk path. It changes only against a spec a person approved: /devloop spec <name>, then /devloop approve.`
    };
  }
  return null;
}
var testNameGlobs = (globs) => globs.filter((glob) => !/(^|\/)\*\*$/.test(glob));
var LOCKED_RULES = ["secret", "harness-state", "spec-locked", "protected", "tests-locked"];
function judgeWrite(path, cfg, loop, where, isProof = true) {
  if (isSecretPlace(path, cfg)) {
    return { rule: "secret", reason: `${path.spelled} holds secrets; it is never read or written from here.` };
  }
  if (isHarnessState(path, where)) {
    return { rule: "harness-state", reason: harnessStateReason(path, where) };
  }
  if (path.rel === null) {
    const outside = spellings(path);
    const isGuarded = outside.some((one) => matchesAny(one, BUILTIN_PROTECTED)) && ![...outside, path.spelled].some((one) => isExempt(one, loop));
    return isGuarded ? { rule: "protected", reason: `${path.spelled} configures the agent, git or the shell, which the building agent does not edit. A person can exempt it for one turn with /devloop allow ${path.spelled}.` } : null;
  }
  const { dir, within } = globParts(path.rel);
  const isFolder = within !== "" || where.folders[dir] !== false;
  const listed = where.filesUnder[dir];
  const isUntracked = listed !== undefined && listed.length === 0 && !Object.keys(loop.testHashes ?? {}).some((file) => file === dir || file.startsWith(`${dir}/`));
  const verdict = (within === "" ? null : judgeEdit(path.rel, cfg, loop, path.rel, isUntracked)) ?? judgeContents(dir, within, cfg, loop, listed ?? [], isFolder, isUntracked);
  return verdict === null || isProof || LOCKED_RULES.includes(verdict.rule) ? verdict : null;
}
function globParts(rel) {
  const parts = rel.split("/");
  const wild = parts.findIndex((part) => /[*?[]/.test(part));
  return wild < 0 ? { dir: rel, within: "" } : { dir: parts.slice(0, wild).join("/"), within: parts.slice(wild).join("/") };
}
function literalPrefix(glob) {
  const parts = glob.split("/");
  const end = parts.findIndex((part) => /[*?[]/.test(part));
  return (end < 0 ? parts.slice(0, -1) : parts.slice(0, end)).join("/");
}
function exemplar(glob) {
  const made = glob.replace(/\*\*\//g, "").replace(/\*\*/g, "x").replace(/\*/g, "x").replace(/\?/g, "x");
  return made !== "" && matches(made, glob) ? made : null;
}
function judgeContents(dir, within, cfg, loop, listed, isFolder = true, isUntracked = false) {
  if (dir !== "" && within === "") {
    const own = judgeEdit(dir, cfg, loop, dir, isUntracked);
    if (own !== null || !isFolder) {
      return own;
    }
  }
  const locked = [
    ...cfg.protected,
    ...BUILTIN_PROTECTED,
    ...cfg.tests,
    ...cfg.tiers.high,
    ...loop.spec === null ? [] : [`specs/${loop.spec}/**`]
  ];
  for (const { path, label } of lockedBeneath(dir, within, locked, listed)) {
    const verdict = judgeEdit(path, cfg, loop, label, isUntracked);
    if (verdict !== null && verdict.rule !== "secret" && verdict.rule !== "spec-first") {
      return verdict;
    }
  }
  return null;
}
function lockedBeneath(dir, within, globs, listed) {
  const shown = dir === "" ? "." : `${dir}/`;
  const isWithin = (path) => {
    if (within === "") {
      return true;
    }
    const parts = path.split("/");
    return parts.some((_, i) => compile(within).test(parts.slice(0, i + 1).join("/")));
  };
  const candidates = [];
  for (const glob of globs) {
    const probe = dir === "" ? null : `${dir}/x`;
    if (probe !== null && matches(probe, glob)) {
      candidates.push({ path: probe, label: `${shown} (everything in it matches ${glob})` });
      continue;
    }
    const prefix = literalPrefix(glob);
    const isBeneath = dir === "" || prefix === dir || prefix.startsWith(`${dir}/`);
    const made = isBeneath ? exemplar(glob) : null;
    if (made !== null && (dir === "" || made.startsWith(`${dir}/`))) {
      candidates.push({ path: made, label: `${shown} (it holds paths matching ${glob})` });
    }
  }
  for (const file of listed) {
    candidates.push({ path: file, label: `${shown} (it holds ${file})` });
  }
  return candidates.filter(({ path }) => isWithin(dir === "" ? path : path.slice(dir.length + 1)));
}
var words = (segment) => operands(segment.args).map((word) => word.text);
var ghWords = (args) => operands(args, "R", ["--repo"]).map((word) => word.text);
function productionAction(segment) {
  const said = words(segment);
  switch (segment.program) {
    case "kubectl":
      return said.some((one) => one === "apply" || one === "delete") ? "kubectl apply/delete" : null;
    case "terraform":
    case "tofu":
      return said.some((one) => one === "apply" || one === "destroy") ? "terraform apply/destroy" : null;
    case "npm":
    case "pnpm":
    case "yarn":
      return said.includes("publish") && !["run", "run-script", "exec", "x", "dlx"].includes(said[0] ?? "") ? `${segment.program} publish` : null;
    case "docker":
    case "podman":
      return said.includes("push") ? "docker push" : null;
    case "gh": {
      const gh = ghWords(segment.args);
      return gh[0] === "release" && gh[1] === "create" ? "gh release create" : null;
    }
    case "aws":
    case "gcloud":
    case "az":
      return said.some((one) => /^(deploy|delete)(-|$)/.test(one)) ? "a cloud deploy or delete" : null;
    default:
      return null;
  }
}
var SAFER_WORKTREE = "`git stash push --include-untracked` keeps the work recoverable (`git stash pop` brings it back); to restore one file, `git restore <file>`";
function destructiveAction(segment, where) {
  const { program, args } = segment;
  if (program === "git") {
    const { sub, at } = gitSub(args);
    const rest = args.slice(at + 1);
    const said = operands(rest).map((word) => word.text);
    const isWholeTree = (paths) => paths.some((path) => [".", "./", ":/", "*", ":(top)"].includes(path));
    if (sub === "reset" && gitOption(rest, ["--hard"]) !== null) {
      return { what: "`git reset --hard` discards every uncommitted change", safer: `${SAFER_WORKTREE}; to move the branch and keep edits, \`git reset --keep <commit>\`` };
    }
    if (sub === "checkout" && (gitOption(rest, ["--force"], "f") !== null || isWholeTree(said))) {
      return { what: "`git checkout` of the whole tree discards every uncommitted change", safer: SAFER_WORKTREE };
    }
    if (sub === "restore" && isWholeTree(said) && (!gitOptionExactly(rest, ["--staged"], "S") || gitOption(rest, ["--worktree"], "W") !== null)) {
      return { what: "`git restore` of the whole tree discards every uncommitted change", safer: SAFER_WORKTREE };
    }
    if (sub === "clean" && gitOption(rest, ["--force"], "f") !== null && !gitOptionExactly(rest, ["--dry-run"], "n")) {
      return { what: "`git clean -f` deletes untracked files, which git cannot bring back", safer: "`git clean -n` lists what it would delete; `git stash push --include-untracked` keeps those files recoverable" };
    }
    if (sub === "stash" && ["drop", "clear"].includes(said[0] ?? "")) {
      return { what: `\`git stash ${said[0] ?? ""}\` deletes stashed work, which may be its only copy`, safer: "leave the stash; `git stash show -p` shows what it holds, and a person can drop it" };
    }
    if (sub === "branch" && (gitOption(rest, ["--delete"], "d") !== null || gitOption(rest, [], "D") !== null)) {
      return { what: "deleting a branch", safer: "leave the branch; deleting one is a person's call" };
    }
    if (sub === "push" && (gitOption(rest, ["--delete"], "d") !== null || said.slice(1).some((spec) => spec.startsWith(":") && spec.length > 1))) {
      return { what: "deleting a remote branch", safer: "leave the branch; deleting one is a person's call" };
    }
    return null;
  }
  if (program === "rm" && (hasFlag(args, "r", ["--recursive"]) || hasFlag(args, "R", []))) {
    for (const word of operands(args)) {
      const isTmpVar = word.lead === "TMPDIR" && where.tmp !== null && (word.text === "" || word.text.startsWith("/"));
      if (word.hasExpansion && !isTmpVar) {
        return { what: `\`rm -rf\` of \`${word.text || "$…"}\`, a path known only when it runs`, safer: "name the path to delete literally, inside the repository" };
      }
      const text = isTmpVar ? `${where.tmp ?? ""}${word.text}` : word.text;
      const prefix = text.replace(/\/?[^/]*[*?[].*$/, "");
      const spellings = word.hasGlob ? [...new Set([prefix || ".", prefix || (text.startsWith("/") ? "/" : ".")])] : [text];
      for (const spelled of spellings) {
        const placed = place(spelled, segment.cwd, where);
        if (placed.abs === null) {
          continue;
        }
        if (placed.rel === null && isTemporary(word.hasGlob ? place(text, segment.cwd, where).abs ?? "" : placed.abs, word.hasGlob, where)) {
          continue;
        }
        if (placed.rel === "" || placed.rel === null) {
          return {
            what: placed.rel === "" ? "`rm -rf` of the repository root" : `\`rm -rf\` of ${placed.abs}, outside the repository`,
            safer: "delete the specific paths inside the repository that need to go; whole trees and anything outside it are a person's to remove"
          };
        }
      }
    }
  }
  return null;
}
var TEMPORARY = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
function isTemporary(abs, isGlob, where) {
  const roots = [...TEMPORARY, ...where.tmp === null ? [] : [normalize(where.tmp)]].filter((one) => one !== "/");
  const path = normalize(abs);
  if (!roots.some((one) => path.startsWith(`${one}/`))) {
    return false;
  }
  const kept = [where.stateRoot, normalize(where.root), ...where.library ?? []].filter((one) => one !== null);
  const pattern = isGlob ? compile(path.replace(/^\//, "")) : null;
  return !kept.some((one) => {
    const parts = one.split("/");
    const lies = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((prefix) => prefix !== "");
    return lies.some((prefix) => pattern === null ? prefix === path : pattern.test(prefix.replace(/^\//, "")));
  });
}
var FETCHERS = ["curl", "wget"];
var SHELL_RUNNERS = ["sh", "bash", "zsh", "dash", "ksh", "source", "."];
var INTERPRETER_RUNNERS = ["python", "python3", "perl", "ruby", "node"];
function readsProgram(segment) {
  const program = segment.program ?? "";
  if (!INTERPRETER_RUNNERS.includes(program) && !/^python\d/.test(program)) {
    return false;
  }
  const isInline = segment.args.some((word) => !word.isQuoted && /^-(?:[a-zA-Z]*[cmeEp]|-eval|-print)$/.test(word.text));
  const script = operands(segment.args, "WX")[0];
  return !isInline && (script === undefined || script.text === "-");
}
function isPipeToShell(segments) {
  const fetches = segments.filter((one) => one.program !== null && FETCHERS.includes(one.program));
  if (fetches.length === 0) {
    return false;
  }
  return segments.some((one) => {
    const program = one.program ?? "";
    const isShell = SHELL_RUNNERS.includes(program);
    const isPiped = fetches.some((fetch) => fetch.pipeline === one.pipeline && fetch.place < one.place);
    if (isPiped && (isShell || readsProgram(one))) {
      return true;
    }
    if (!isShell || !fetches.some((fetch) => fetch.isNested)) {
      return false;
    }
    const flag = one.args.findIndex((word) => !word.isQuoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text));
    const script = flag >= 0 ? one.args[flag + 1] : operands(one.args)[0];
    return script !== undefined && script.hasExpansion && (flag >= 0 || script.text === "/dev/fd/63");
  });
}
var LOOPBACK = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
function isAllowedHost(host, allow) {
  return LOOPBACK.includes(host) || allow.some((entry) => entry === host || entry.startsWith("*.") && host.endsWith(entry.slice(1)));
}
var COMMIT_VALUES = "mFCctu";
function gitConfigValues(globals) {
  const out = [];
  for (let i = 0;i < globals.length; i += 1) {
    const word = globals[i];
    if (word.text === "-c" && globals[i + 1] !== undefined) {
      out.push(globals[i + 1]);
      i += 1;
    } else if (isGitLong(word, "--config-env")) {
      out.push(...gitOptionValues([word, ...globals.slice(i + 1, i + 2)], "--config-env"));
      i += word.text.includes("=") ? 0 : 1;
    }
  }
  return out;
}
function isNoVerify(segment) {
  const { sub, at } = gitSub(segment.args);
  const globals = segment.args.slice(0, at);
  if (gitConfigValues(globals).some((one) => /^core\.hookspath=/i.test(one.text))) {
    return true;
  }
  const rest = segment.args.slice(at + 1);
  if (!["commit", "push", "merge", "rebase", "am", "cherry-pick", "revert", "pull"].includes(sub ?? "")) {
    return false;
  }
  if (gitOption(rest, ["--no-verify"]) !== null) {
    return true;
  }
  if (sub !== "commit") {
    return false;
  }
  return rest.some((word) => {
    if (word.isQuoted || !/^-[A-Za-z]+$/.test(word.text)) {
      return false;
    }
    for (const letter of word.text.slice(1)) {
      if (letter === "n") {
        return true;
      }
      if (COMMIT_VALUES.includes(letter)) {
        return false;
      }
    }
    return false;
  });
}
function isForcePush(segment) {
  const { sub, at } = gitSub(segment.args);
  if (sub !== "push") {
    return false;
  }
  const rest = segment.args.slice(at + 1);
  return gitOption(rest, ["--force"], "f") !== null || operands(rest, "o", ["--push-option", "--repo", "--receive-pack", "--exec"]).slice(1).some((word) => word.text.startsWith("+"));
}
var GIT_READS_BASE = ["diff", "log", "show", "status", "blame", "ls-files", "rev-parse", "merge-base", "grep", "cat-file", "ls-tree"];
var DETACHED = "(detached)";
function switchOf(sub, rest) {
  if (sub !== "checkout" && sub !== "switch") {
    return;
  }
  if (gitOptionExactly(rest, ["--detach"])) {
    return DETACHED;
  }
  const create = sub === "checkout" ? ["-b", "-B", "--orphan"] : ["-c", "-C", "--create", "--force-create", "--orphan"];
  const made = rest.findIndex((word) => create.includes(word.text) || create.some((flag) => flag.startsWith("--") && word.text.startsWith(`${flag}=`)));
  if (made >= 0) {
    const word = rest[made];
    const name = word.text.includes("=") ? word.text.slice(word.text.indexOf("=") + 1) : rest[made + 1]?.text;
    return name === undefined || rest[made + 1]?.hasExpansion === true && !word.text.includes("=") ? null : name;
  }
  if (rest.some((word) => word.text === "--")) {
    return;
  }
  const said = operands(rest, "", ["--conflict"]);
  if (said.length !== 1) {
    return;
  }
  const only = said[0];
  if (only.hasExpansion || only.text === "-" || only.text.startsWith("@{")) {
    return null;
  }
  return only.text === "." || only.hasGlob ? undefined : only.text;
}
var UNNAMED_PUSHES = ["--all", "--branches", "--tags", "--follow-tags", "--mirror"];
var PUSH_OPTIONS = ["-u", "--set-upstream", "-n", "--dry-run", "-v", "--verbose", "-q", "--quiet", "--progress", "--no-progress", "--porcelain", "--atomic", "--no-follow-tags", "--force-with-lease", "--no-verify"];
var SHIP_GLOBALS = ["--no-pager", "-P", "-p", "--paginate"];
var PUSH_ADVICE = "Push the branch you are on in the one shape the harness judges: `git push -u origin HEAD` (or `git push origin HEAD:refs/heads/<branch>` for its own branch on the remote, the destination spelled in full), as its own command.";
function pushShape(segment, line) {
  const { at } = gitSub(segment.args);
  const globals = segment.args.slice(0, at);
  const configuring = globals.find((word) => !SHIP_GLOBALS.includes(word.text));
  if (configuring !== undefined) {
    return `the git option ${configuring.text} before \`push\` (nothing configures git on a shipping line: -c, --config-env, --git-dir, --work-tree, --namespace and -C are refused there)`;
  }
  const variable = line.flatMap((one) => [
    ...one.assigned.map((each) => each.name),
    ...one.program !== null && ["export", "declare", "typeset", "readonly", "local", "env"].includes(one.program) ? operands(one.args).map((word) => word.text.replace(/=.*$/, "")) : []
  ]).find((name) => /^GIT_[A-Za-z0-9_]*$/.test(name));
  if (variable !== undefined) {
    return `${variable} set on the line (no GIT_* variable is assigned or exported on a shipping line)`;
  }
  const rest = segment.args.slice(at + 1);
  const said = [];
  let isEnd = false;
  for (const word of rest) {
    if (!isEnd && word.text === "--") {
      isEnd = true;
    } else if (!isEnd && word.text.startsWith("-") && word.text !== "-") {
      if (!PUSH_OPTIONS.includes(word.text) && !word.text.startsWith("--force-with-lease=")) {
        const unnamed = UNNAMED_PUSHES.find((one) => isGitLong(word, one));
        return unnamed === undefined ? `the option ${word.text} (a push takes only ${PUSH_OPTIONS.join(", ")}, each spelled in full)` : `${word.text}, which names no source: it sends ${unnamed === "--tags" || unnamed === "--follow-tags" ? "tags" : "branches or refs"} beside (or instead of) the branch the gate judged`;
      }
    } else {
      said.push(word);
    }
  }
  if (said.length !== 2) {
    return said.length < 2 ? "no remote and refspec named: a bare push sends whatever git is configured to send" : "more than one refspec";
  }
  const [remote, spec] = said;
  if (remote.hasExpansion || spec.hasExpansion || remote.text === "" || spec.text === "") {
    return "a remote or refspec known only when the line runs";
  }
  if (spec.hasGlob || spec.text.startsWith("+") || spec.text.startsWith(":") || spec.text.split(":").length > 2) {
    return `the refspec ${spec.text} (one source, no +, no pattern, no deletion)`;
  }
  const source = spec.text.includes(":") ? spec.text.slice(0, spec.text.indexOf(":")) : spec.text;
  const bare = source.replace(/^refs\/heads\//, "");
  if (source !== "HEAD" && (bare === "" || bare.startsWith("refs/") || /[~^@:]/.test(bare) || /^[0-9a-f]{7,64}$/i.test(bare))) {
    return `the source ${source} (a push sends HEAD or the branch checked out, by name)`;
  }
  if (spec.text.includes(":")) {
    const destination = spec.text.slice(spec.text.indexOf(":") + 1);
    if (!/^refs\/heads\/[^/]/.test(destination)) {
      const named = /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(destination) && !destination.startsWith("refs/") && !/^(?:heads|tags|remotes)\//.test(destination) ? destination : "<branch>";
      return `the destination ${destination} (spell it in full, as \`${source}:refs/heads/${named}\`: git places an unqualified destination by what the remote already has)`;
    }
  }
  return null;
}
function shipsOf(command) {
  return unionBy(readings(command).flatMap((segments) => shipsBySegment(segments).filter((one) => one !== null)), (one) => JSON.stringify(one));
}
function shipsBySegment(segments) {
  let on;
  return segments.map((segment) => {
    if (segment.isBeyondDepth === true) {
      return { kind: "push", targets: [], sources: [], isAll: true, on };
    }
    if (segment.program === "git") {
      const { sub, at } = gitSub(segment.args);
      const rest = segment.args.slice(at + 1);
      const moved = switchOf(sub, rest);
      if (moved !== undefined) {
        on = moved;
      }
      if (hasGitAlias(segment.args)) {
        return { kind: "push", targets: [], sources: [], isAll: true, on };
      }
      if (sub === "push") {
        const specs = operands(rest, "o", ["--push-option", "--repo", "--receive-pack", "--exec"]).slice(1);
        const parts = specs.map((spec) => {
          const text = spec.text.replace(/^\+/, "");
          const isPair = text.includes(":");
          const dst = isPair ? text.slice(text.indexOf(":") + 1) : text;
          return { target: dst.replace(/^refs\/heads\//, ""), source: (isPair ? text.slice(0, text.indexOf(":")) : text) || "HEAD" };
        });
        const unnamed = gitOptionWords(rest).find((word) => UNNAMED_PUSHES.some((one) => isGitLong(word, one)))?.text ?? null;
        const misshapen = pushShape(segment, segments);
        return {
          kind: "push",
          targets: parts.map((one) => one.target),
          sources: parts.map((one) => one.source),
          isAll: gitOption(rest, ["--all", "--mirror", "--branches"]) !== null,
          ...unnamed === null ? {} : { unnamed },
          ...misshapen === null ? {} : { misshapen },
          on
        };
      }
      if (sub === "merge" && !gitOptionExactly(rest, ["--abort", "--quit"])) {
        return { kind: "merge", on };
      }
    } else if (segment.program === "gh") {
      const [noun, action] = ghWords(segment.args);
      if (noun === "pr" && (action === "create" || action === "ready" || action === "merge")) {
        return { kind: `pr-${action}`, on };
      }
    }
    return null;
  });
}
var GIT_SHIP_READS = [...GIT_READS_BASE, "remote", "describe", "shortlog", "reflog", "symbolic-ref", "for-each-ref", "show-ref", "name-rev"];
var GIT_ELSEWHERE = ["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"];
var isOptionNamed = (word, names) => !/\s/.test(word.text) && names.some((name) => isGitLong(word, name) || name.length === 2 && word.text.startsWith(name) && !word.text.startsWith("--"));
function isGitRead(segment) {
  const { sub, at } = gitSub(segment.args);
  const globals = segment.args.slice(0, at);
  if (globals.some((word) => isOptionNamed(word, GIT_ELSEWHERE))) {
    return false;
  }
  const rest = segment.args.slice(at + 1);
  if (gitOptionWords(rest).some((word) => isOptionNamed(word, GIT_WRITING))) {
    return false;
  }
  const said = operands(rest);
  switch (sub) {
    case "branch":
      return rest.every((word) => /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--verbose|--no-color|--color)$/.test(word.text));
    case "remote": {
      const first = said[0]?.text;
      const before = first === undefined ? rest : rest.slice(0, rest.findIndex((word) => word.text === first));
      return before.every((word) => word.text === "-v" || word.text === "--verbose") && (first === undefined || first === "show" || first === "get-url");
    }
    case "reflog": {
      const first = said[0]?.text;
      return first === undefined || !["expire", "delete", "drop"].includes(first);
    }
    case "symbolic-ref":
      return said.length <= 1 && gitOption(rest, ["--delete"], "d") === null && gitOption(rest, [], "m") === null;
    default:
      return sub !== null && GIT_SHIP_READS.includes(sub);
  }
}
var SHIP_READERS = ["echo", "printf", "pwd", "true", "test", "[", "date", "whoami", "which", "type"];
function isShipCompanion(segment) {
  if (segment.program === "cd" || segment.program === "pushd" || segment.program === "popd") {
    return segment.redirects.every((one) => !one.isWrite) && segment.writes.length === 0;
  }
  if (segment.isUnknown || segment.writes.length > 0 || segment.maybeWrites.length > 0 || segment.redirects.some((one) => one.isWrite) || segment.assignments.length > 0) {
    return false;
  }
  const program = segment.program;
  if (program === null) {
    return false;
  }
  if (program === "git") {
    return isGitRead(segment);
  }
  return SHIP_READERS.includes(program) || READERS[program] !== undefined && isReaderSegment({ ...segment, isNested: false, wrappers: [] });
}
var isMergeShip = (intent, branch, defaultBranch) => intent.on === undefined ? branch === null || branch === defaultBranch : intent.on === null || intent.on === defaultBranch;
function shipIntents(segments, branch, defaultBranch) {
  return shipsBySegment(segments).map((one) => one !== null && (one.kind !== "merge" || isMergeShip(one, branch, defaultBranch)) ? one : null);
}
function shipAloneIn(segments, branch, defaultBranch) {
  const ships = shipIntents(segments, branch, defaultBranch);
  const count = ships.filter((one) => one !== null).length;
  if (count === 0) {
    return null;
  }
  const isPlainShip = (segment, i) => {
    const one = ships[i];
    return one !== null && one !== undefined && (count === 1 || one.kind !== "merge" && !segment.isUnknown);
  };
  const others = segments.filter((segment, i) => !isPlainShip(segment, i) && !isShipCompanion(segment));
  if (others.length === 0) {
    return null;
  }
  const named = [...new Set(others.map((one) => [one.program ?? "(computed)", one.program === "git" ? gitSub(one.args).sub : null].filter(Boolean).join(" ")))].slice(0, 3);
  return {
    rule: "ship-alone",
    reason: `This line ships and also runs ${named.join(", ")}. Run the push (or the pull request) as its own command, so the harness can judge exactly what is being pushed: the gate judges the tree before a line runs, and a line that changes the tree and ships it would ship work the gate never saw.`
  };
}
function shipElsewhereIn(segments, where, defaultBranch) {
  const ships = shipIntents(segments, where.branch, defaultBranch);
  for (const [i, segment] of segments.entries()) {
    if (ships[i] === null || ships[i] === undefined) {
      continue;
    }
    const globals = segment.program === "git" ? segment.args.slice(0, gitSub(segment.args).at) : [];
    const isPointed = globals.some((word) => isOptionNamed(word, ["--git-dir", "--work-tree"])) || segment.assignments.some((one) => /^GIT_(DIR|WORK_TREE)=/.test(one));
    const repo = segment.program === "gh" ? flagValue(segment.args, "-R", "--repo") : null;
    if (repo !== null && (where.remote === undefined || where.remote === null || repoSlug(repo) !== where.remote)) {
      return {
        rule: "gate",
        reason: `This ships to ${repo}, which is not this repository's remote (${where.remote ?? "not known here"}), and the harness can judge only this repository. Run it without -R/--repo, from inside the repository it ships.`
      };
    }
    const here = segment.cwd === null ? null : place(".", segment.cwd, where);
    if (isPointed || here === null || here.rel === null) {
      const from = isPointed ? "another git directory" : here === null || here.abs === null ? "a directory the harness cannot follow" : here.abs;
      return {
        rule: "gate",
        reason: `This ships from ${from}, and the harness can judge only this repository (${where.root}). Run the push from inside it, as its own command.`
      };
    }
  }
  return null;
}
function repoSlug(named) {
  const bare = named.trim().replace(/\.git$/, "").replace(/\/+$/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, "").replace(/^[^@/]+@[^:]+:/, "");
  const parts = bare.split("/").filter((one) => one !== "");
  return parts.slice(-2).join("/").toLowerCase();
}
var EVIDENCE_REF = "refs/notes/devloop";
var isEvidenceRef = (ref) => {
  const bare = ref.replace(/^\+/, "").replace(/^:/, "");
  const name = bare.includes(":") ? bare.slice(bare.indexOf(":") + 1) : bare;
  return [bare, name].some((one) => one === "devloop" || one === "notes/devloop" || one === EVIDENCE_REF || /^(refs\/)?notes\//.test(one) && /[*?[]/.test(one) || one === "refs/notes" || one === "refs/notes/");
};
var isEvidenceDestination = (spec) => {
  const text = spec.replace(/^\+/, "");
  if (!text.includes(":")) {
    return false;
  }
  const dst = text.slice(text.indexOf(":") + 1);
  return /^(refs\/)?notes\/devloop$/.test(dst) || /^(refs\/)?notes(\/|$)/.test(dst) && (/[*?[]/.test(dst) || /^(refs\/)?notes\/?$/.test(dst)) || /\$/.test(dst);
};
var mayBeEvidenceRef = (value) => isEvidenceRef(value) || /\$/.test(value);
var NOTES_READS = ["list", "show", "get-ref"];
function evidenceNotesWrite(segment, earlier = []) {
  if (segment.program !== "git") {
    return null;
  }
  const { sub, at } = gitSub(segment.args);
  const globals = segment.args.slice(0, at);
  const rest = segment.args.slice(at + 1);
  const settings = gitConfigValues(globals);
  const lineSettings = (pattern) => {
    const all = [...segment.assigned, ...earlier.flatMap((one) => [...one.assigned, ...one.program !== null && ["export", "declare", "typeset", "readonly", "local"].includes(one.program) ? one.args.filter((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)).map((word) => ({ name: word.text.slice(0, word.text.indexOf("=")), value: word.text.slice(word.text.indexOf("=") + 1), isComputed: word.hasExpansion })) : []])];
    return all.filter((one) => pattern.test(one.name));
  };
  const viaEnvConfig = lineSettings(/^GIT_CONFIG_(PARAMETERS|KEY_\d+|VALUE_\d+)$/).filter((one) => one.isComputed || /notesref|remote\..*\.fetch|refs\/notes/i.test(one.value));
  if (sub === "notes") {
    const isComputedWord = (word) => word.hasExpansion;
    const refWords = gitOptionValues(rest, "--ref");
    const fromEnv = [...segment.assigned.filter((one) => one.name === "GIT_NOTES_REF"), ...assignedBefore("GIT_NOTES_REF", earlier)];
    const fromConfig = settings.filter((word) => /^core\.notesref=/i.test(word.text) || /^core\.notesref=/i.test(word.text.replace(/^-c/, "")));
    const fromConfigEnv = globals.some((word) => isGitLong(word, "--config-env")) && settings.some((word) => /^core\.notesref=/i.test(word.text));
    const refs = refWords.length > 0 ? refWords.map((word) => ({ value: word.text, isComputed: isComputedWord(word) })) : [
      ...fromEnv,
      ...fromConfig.map((word) => ({ value: word.text.replace(/^[^=]*=/, ""), isComputed: isComputedWord(word) || fromConfigEnv })),
      ...viaEnvConfig.map((one) => ({ value: one.value, isComputed: true }))
    ];
    let action = "list";
    for (let i = 0;i < rest.length; i += 1) {
      const word = rest[i];
      if (isGitLong(word, "--ref")) {
        i += word.text.includes("=") ? 0 : 1;
      } else if (!word.text.startsWith("-")) {
        action = word.text;
        break;
      }
    }
    const ref = refs.find((one) => one.isComputed || mayBeEvidenceRef(one.value)) ?? null;
    if (ref !== null && !NOTES_READS.includes(action)) {
      return `\`git notes ${action}\` on ${EVIDENCE_REF}${!ref.isComputed && isEvidenceRef(ref.value) ? "" : " (or on a ref known only when the line runs)"}`;
    }
    return null;
  }
  if (sub === "update-ref") {
    const said = operands(rest, "m", []);
    if (said.some((word) => isEvidenceRef(word.text)) || said[0]?.hasExpansion === true) {
      return `\`git update-ref\` of ${EVIDENCE_REF}${said[0]?.hasExpansion === true ? " (or of a ref known only when the line runs)" : ""}`;
    }
    return null;
  }
  if (sub === "symbolic-ref") {
    const said = operands(rest, "m", []);
    const isWrite = said.length >= 2 || gitOption(rest, ["--delete"], "d") !== null;
    if (isWrite && said.some((word) => word.hasExpansion || isEvidenceRef(word.text))) {
      return `\`git symbolic-ref\` of ${EVIDENCE_REF} (or of a ref known only when the line runs)`;
    }
    return null;
  }
  if (sub === "fetch" || sub === "pull") {
    const specs = operands(rest, "oj", ["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--upload-pack", "--negotiation-tip", "--server-option", "--jobs", "--refmap", "--recurse-submodules-default"]).slice(1);
    const refmaps = gitOptionValues(rest, "--refmap");
    const fetchSettings = [...settings.filter((word) => /^remote\..*\.fetch=/i.test(word.text)).map((word) => ({ ...word, text: word.text.replace(/^[^=]*=/, "") })), ...viaEnvConfig.map((one) => ({ text: one.value, hasExpansion: true }))];
    if ([...specs, ...refmaps, ...fetchSettings].some((word) => word.hasExpansion || isEvidenceDestination(word.text))) {
      return `a ${sub} into ${EVIDENCE_REF}${[...specs, ...refmaps, ...fetchSettings].some((word) => word.hasExpansion) ? " (or into a ref known only when the line runs)" : ""}`;
    }
    return null;
  }
  if (sub === "push") {
    const specs = operands(rest, "o", ["--push-option", "--repo", "--receive-pack", "--exec"]).slice(1);
    if (gitOption(rest, ["--mirror"]) !== null || specs.some((word) => word.hasExpansion || isEvidenceRef(word.text))) {
      return `a push of ${EVIDENCE_REF}${specs.some((word) => word.hasExpansion) ? " (or of a ref known only when the line runs)" : ""}`;
    }
  }
  return null;
}
function hidesFromGit(segment) {
  const { sub, at } = gitSub(segment.args);
  if (sub !== "update-index") {
    return null;
  }
  return gitOption(segment.args.slice(at + 1), ["--skip-worktree", "--assume-unchanged"]);
}
var NOTES_PLUMBING = ["fast-import", "update-ref", "symbolic-ref", "hash-object", "mktree", "commit-tree", "replace"];
var NAMES_REF = /(^|[^A-Za-z0-9_./-])(refs\/)?notes\/devloop($|[^A-Za-z0-9_-])|refs\/notes\/[*?[]/;
function notesPlumbingWrite(segment, command, line = []) {
  if (segment.program !== "git") {
    return null;
  }
  const { sub } = gitSub(segment.args);
  if (sub === null || !NOTES_PLUMBING.includes(sub)) {
    return null;
  }
  if (sub === "hash-object" && gitOption(segment.args.slice(gitSub(segment.args).at + 1), [], "w") === null) {
    return null;
  }
  const isNamed = NAMES_REF.test(command) || line.some((one) => [...one.words.map((word) => word.text), ...one.assignments, ...one.redirects.map((each) => each.target)].some((text) => NAMES_REF.test(text)));
  return isNamed ? `\`git ${sub}\` in a line that names ${EVIDENCE_REF}` : null;
}
function pushesOtherBranch(intent, branch) {
  if (intent.kind !== "push") {
    return null;
  }
  const current = intent.on === undefined ? branch : intent.on;
  return intent.sources.map((one) => one.replace(/^refs\/heads\//, "")).find((one) => one !== "HEAD" && one !== "@" && one !== current) ?? null;
}
function shipLookups(command) {
  const each = readings(command).map((segments) => {
    const ships = shipsBySegment(segments);
    return {
      isShip: ships.some((one) => one !== null),
      hasMerge: ships.some((one) => one !== null && one.kind === "merge" && one.on === undefined),
      hasRepoFlag: segments.some((segment, i) => ships[i] !== null && ships[i] !== undefined && segment.program === "gh" && flagValue(segment.args, "-R", "--repo") !== null)
    };
  });
  return { isShip: each.some((one) => one.isShip), hasMerge: each.some((one) => one.hasMerge), hasRepoFlag: each.some((one) => one.hasRepoFlag) };
}
function isOnDefault(intent, branch, defaultBranch) {
  return intent.on === undefined ? branch === defaultBranch : intent.on === null || intent.on === defaultBranch;
}
function isPushToDefault(intent, branch, defaultBranch) {
  if (intent.kind !== "push") {
    return false;
  }
  return intent.isAll || intent.targets.includes(defaultBranch) || (intent.targets.length === 0 || intent.targets.includes("HEAD")) && isOnDefault(intent, branch, defaultBranch);
}
var pathOf = (word) => word.text.replace(/^--?[A-Za-z][\w-]*=/, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
function namedPaths(segment) {
  const isUrl = (text) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const isValue = (word) => /^-[\w-]*=|^[A-Za-z_]\w*=/.test(word.text) && !word.hasExpansion && !/\s/.test(word.text);
  const args = segment.program === null ? segment.words : segment.args;
  return [
    ...args.filter(isPathLike).map(pathOf),
    ...args.filter(isValue).map(pathOf),
    ...segment.assignments.map((one) => one.replace(/^[^=]*=/, "")),
    ...segment.redirects.map((one) => one.target),
    ...segment.named
  ].filter((path) => path !== "" && path !== "-" && !isUrl(path));
}
function lineLinks(segments, where) {
  const out = [];
  let made = [];
  for (const segment of segments) {
    out.push(made);
    const more = [];
    for (const one of segment.links) {
      const name = place(one.name, segment.cwd, where).abs;
      const from = one.isSymbolic && !one.target.startsWith("/") && !one.target.startsWith("~") && name !== null ? name.slice(0, name.lastIndexOf("/")) || "/" : segment.cwd;
      const target = place(one.target, from, where).abs;
      if (name !== null && target !== null && name !== target) {
        more.push({ name, target });
      }
    }
    made = [...made, ...more];
  }
  return out;
}
var isWild = (spelled) => /[*?[]/.test(spelled);
function lookupOf(segments, where, reading) {
  if (reading === "reviewed") {
    return (abs) => where.globs?.[abs];
  }
  const byKey = new Map;
  for (const ask of globAsksExtended(segments, where)) {
    byKey.set(ask.key, [...byKey.get(ask.key) ?? [], ask.pattern]);
  }
  return (abs) => {
    const answers = (byKey.get(abs) ?? []).map((pattern) => where.globsExtended?.[pattern]).filter((one) => one !== undefined);
    if (answers.length === 0) {
      return;
    }
    return answers.includes("capped") ? "capped" : [...new Set(answers.flatMap((one) => one === "capped" ? [] : one))].sort();
  };
}
function reach(spelled, segment, links, where, lookup) {
  const first = place(spelled, segment.cwd, where);
  const places = [first];
  for (const link of links) {
    for (const one of [...places]) {
      if (one.abs !== null && (one.abs === link.name || one.abs.startsWith(`${link.name}/`))) {
        places.push({ ...place(`${link.target}${one.abs.slice(link.name.length)}`, null, where), spelled });
      }
    }
  }
  let isCapped = false;
  for (const one of [...places]) {
    const found = one.abs === null || !isWild(one.abs) ? undefined : lookup(one.abs);
    if (found === "capped") {
      isCapped = true;
    } else if (found !== undefined) {
      places.push(...found.map((abs) => ({ ...place(abs, null, where), spelled: `${spelled} (${abs})`, isMatch: true })));
    }
  }
  return { places, isCapped };
}
var GLOB_BUDGET = 32;
var SPACED_BUDGET = 200;
var REVIEWED_GLOBS = 16;
var GLOB_ROUNDS = 3;
var LINK_BUDGET = 200;
var WRITE_LINK_BUDGET = 64;
var patternOf = (word) => (word.template ?? word.text).replace(/^--?[A-Za-z][\w-]*=/, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
function globAsks(command, where) {
  return READINGS.map((reading) => {
    const segments = parseOf(command, where, reading);
    return [...reading === "reviewed" ? globAsksReviewed(segments, where) : globAsksExtended(segments, where), ...spacedAsks(segments, where)];
  });
}
function globsWanted(command, at) {
  const kept = (kind) => kind === "reviewed" ? at.globs : kind === "extended" ? at.globsExtended : at.spaced;
  const wanted = globAsks(command, at).flatMap((asks) => {
    const isOver = (kind) => kind === "extended" ? asks.filter((one) => one.kind === kind).length > GLOB_BUDGET : kind === "spaced" && asks.filter((one) => one.kind === kind).length > SPACED_BUDGET;
    return asks.filter((one) => !isOver(one.kind) && kept(one.kind)?.[one.pattern] === undefined);
  });
  return unionBy(wanted, (one) => `${one.kind}\x00${one.pattern}`);
}
function globsAnswered(at, wanted, found) {
  const answers = (kind) => Object.fromEntries(wanted.filter((one) => one.kind === kind).map((one) => [one.pattern, found[kind][one.pattern] ?? "capped"]));
  return {
    ...at,
    globs: { ...at.globs ?? {}, ...answers("reviewed") },
    globsExtended: { ...at.globsExtended ?? {}, ...answers("extended") },
    spaced: { ...at.spaced ?? {}, ...answers("spaced") }
  };
}
var patternsOf = (wanted, kind) => wanted.filter((one) => one.kind === kind).map((one) => one.pattern);
function globAsksReviewed(segments, where) {
  const out = new Set;
  const links = lineLinks(segments, where);
  segments.forEach((segment, i) => {
    const spelled = [
      ...segment.args.filter((word) => word.hasGlob && !word.hasExpansion).map((word) => pathOf(word)),
      ...segment.redirects.map((one) => one.target).filter(isWild),
      ...segment.named.filter(isWild)
    ];
    for (const one of spelled) {
      const first = place(one, segment.cwd, where);
      for (const each of [first, ...(links[i] ?? []).flatMap((link) => first.abs !== null && first.abs.startsWith(`${link.name}/`) ? [place(`${link.target}${first.abs.slice(link.name.length)}`, null, where)] : [])]) {
        if (each.abs !== null && isWild(each.abs)) {
          out.add(each.abs);
        }
      }
    }
  });
  return [...out].slice(0, REVIEWED_GLOBS).map((key) => ({ kind: "reviewed", key, pattern: key }));
}
function globAsksExtended(segments, where) {
  const out = new Map;
  const add = (key, pattern) => {
    const id = `${key}\x00${pattern}`;
    if (!out.has(id)) {
      out.set(id, { kind: "extended", key, pattern });
    }
  };
  const links = lineLinks(segments, where);
  segments.forEach((segment, i) => {
    if (segment.moveGlob !== null) {
      add(segment.moveGlob, segment.moveGlob);
    }
    const spelled = [
      ...segment.args.filter((word) => word.hasGlob && !word.hasExpansion).map((word) => ({ text: pathOf(word), glob: patternOf(word) })),
      ...[...segment.redirects.map((one) => one.target), ...segment.named].filter(isWild).map((text) => ({ text, glob: text }))
    ];
    for (const one of spelled) {
      const first = place(one.text, segment.cwd, where);
      const glob = place(one.glob, segment.cwd, where).abs;
      const asks = [{ key: first.abs, pattern: glob }, ...(links[i] ?? []).flatMap((link) => first.abs !== null && first.abs.startsWith(`${link.name}/`) ? [{ key: place(`${link.target}${first.abs.slice(link.name.length)}`, null, where).abs, pattern: glob !== null && glob.startsWith(`${link.name}/`) ? place(`${link.target}${glob.slice(link.name.length)}`, null, where).abs : null }] : [])];
      for (const { key, pattern } of asks) {
        if (key !== null && isWild(key)) {
          add(key, pattern ?? key);
        }
      }
    }
  });
  return [...out.values()];
}
var spacedWords = (segment) => (segment.program === null ? segment.words : segment.args).filter((word) => /\s/.test(word.text) && !word.hasExpansion && !word.hasGlob && !word.text.startsWith("-") && !isGlobTemplate(patternOf(word)));
var spacedAsk = (word, segment, where) => {
  const key = place(pathOf(word), segment.cwd, where).abs;
  const pattern = place(patternOf(word), segment.cwd, where).abs;
  return key === null || pattern === null ? null : { kind: "spaced", key, pattern };
};
function spacedAsks(segments, where) {
  return unionBy(segments.flatMap((segment) => spacedWords(segment).flatMap((word) => spacedAsk(word, segment, where) ?? [])), (one) => one.pattern);
}
var spacedPaths = (segment, where, reading) => [
  ...spacedWords(segment).filter((word) => {
    const ask = spacedAsk(word, segment, where);
    const found = ask === null ? undefined : where.spaced?.[ask.pattern];
    return found === "capped" || Array.isArray(found) && found.length > 0;
  }).map(pathOf),
  ...reading === "reviewed" ? [] : (segment.program === null ? segment.words : segment.args).filter((word) => /\s/.test(word.text) && word.hasGlob && !word.hasExpansion && !word.text.startsWith("-")).map(pathOf)
];
var pathsOf = (segment, where, reading) => [...namedPaths(segment), ...spacedPaths(segment, where, reading)];
function linkPlaces(places, budget) {
  const seen = new Set;
  const spelled = [];
  const matched = [];
  for (const one of places) {
    const key = `${one.abs ?? ""}\x00${one.raw ?? ""}`;
    if (one.abs !== null && !seen.has(key)) {
      seen.add(key);
      if (one.isMatch === true) {
        matched.push(one);
      } else {
        spelled.push(one);
      }
    }
  }
  return { places: [...spelled.slice(0, budget), ...matched.slice(0, GLOB_CAP)], isOver: spelled.length > budget || matched.length > GLOB_CAP };
}
function budgetRefusals(command, where, isOptedIn) {
  const out = [];
  const isMissing = (asks, kept) => kept !== undefined && asks.some((one) => kept[one.pattern] === undefined);
  for (const reading of READINGS) {
    const segments = parseOf(command, where, reading);
    const lookups = reading === "reviewed" ? globAsksReviewed(segments, where) : globAsksExtended(segments, where);
    if (reading === "extended" && lookups.length > GLOB_BUDGET || isMissing(lookups, reading === "reviewed" ? where.globs : where.globsExtended)) {
      out.push(`names more wildcard paths than the harness expands for one line (${GLOB_BUDGET})`);
    }
    const spaced = spacedAsks(segments, where);
    if (spaced.length > SPACED_BUDGET || isMissing(spaced, where.spaced)) {
      out.push(`names more words holding white space than the harness looks up for one line (${SPACED_BUDGET})`);
    }
    if (linkPlaces(namedPlacesIn(segments, where, reading), LINK_BUDGET).isOver) {
      out.push(`names more paths than the harness follows through links for one line (${LINK_BUDGET})`);
    }
    if (isOptedIn && linkPlaces(writtenPathsIn(segments, where, reading), WRITE_LINK_BUDGET).isOver) {
      out.push(`writes more paths than the harness follows through links for one line (${WRITE_LINK_BUDGET})`);
    }
  }
  return [...new Set(out)].map((what) => ({
    rule: isOptedIn ? "protected" : "secret",
    reason: `This line ${what}, so the harness cannot judge the rest of it. Split the line into shorter commands.${isOptedIn ? ` A person can allow this exact command for one turn: /devloop allow --command ${command.trim()}` : ""}`
  }));
}
function followedPlaces(byReading, budget) {
  return unionBy(byReading.flatMap((places) => linkPlaces(places, budget).places), (one) => `${one.abs ?? ""}\x00${one.raw ?? ""}`);
}
function folderOf(glob) {
  const isAnywhere = glob.startsWith("**/");
  return { folder: literalPrefix(isAnywhere ? glob.slice(3) : glob), isAnywhere };
}
function guardedFolders(cfg) {
  const out = [];
  for (const [globs, rule] of [[[...BUILTIN_SECRETS, ...cfg.secrets], "secret"], [[...BUILTIN_PROTECTED, ...cfg.protected], "protected"]]) {
    for (const glob of globs) {
      const { folder, isAnywhere } = folderOf(glob);
      if (folder !== "" && !out.some((one) => one.folder === folder && one.rule === rule)) {
        out.push({ folder, isAnywhere, rule, glob });
      }
    }
  }
  return out;
}
var concreteOf = (one, where) => [...!one.isAnywhere || one.rule === "protected" ? [normalize(`${where.root}/${one.folder}`)] : [], ...one.isAnywhere && where.home !== null ? [normalize(`${where.home}/${one.folder}`)] : []];
function folderRefusal(path, isReplace, cfg, where) {
  if (path.abs === null) {
    return null;
  }
  const abs = normalize(path.abs);
  for (const one of guardedFolders(cfg)) {
    const concrete = concreteOf(one, where);
    const isTarget = concrete.includes(abs) || one.isAnywhere && abs.endsWith(`/${one.folder}`);
    const below = `${abs === "/" ? "" : abs}/`;
    const isAncestor = isReplace && concrete.some((each) => each.startsWith(below));
    if (isTarget || isAncestor) {
      const what = isTarget ? `${path.spelled} is the folder ${one.glob} guards` : `${path.spelled} holds ${concrete.find((each) => each.startsWith(below)) ?? one.folder}, the folder ${one.glob} guards`;
      return one.rule === "secret" ? { rule: "secret", reason: `${what}: it holds secrets, so no command writes, moves or replaces it from here.` } : { rule: "protected", reason: `${what}: it configures the agent, git or the harness, so no command writes into, moves, deletes or replaces it from here. A person can exempt it for one turn with /devloop allow ${path.spelled}.` };
    }
  }
  return null;
}
function deepReadRefusal(path, cfg, where) {
  if (path.abs === null) {
    return null;
  }
  const abs = normalize(path.abs);
  for (const one of guardedFolders(cfg).filter((each) => each.rule === "secret")) {
    const inside = concreteOf(one, where).find((each) => each === abs || each.startsWith(`${abs === "/" ? "" : abs}/`));
    if (inside !== undefined) {
      return { rule: "secret", reason: `${path.spelled} is read recursively, and ${inside} beneath it holds secrets (${one.glob}); name the files to read instead.` };
    }
  }
  return null;
}
var PYTHONS = /^(?:python[0-9.]*|py|pypy[0-9.]*)$/;
function runsCacheGuard(segment) {
  const program = segment.program;
  if (program === null) {
    return false;
  }
  if (program === "cache_guard.py") {
    return true;
  }
  if (!PYTHONS.test(program)) {
    return false;
  }
  const args = segment.args;
  const module = args.flatMap((word, i) => word.text === "-m" ? [args[i + 1]?.text ?? ""] : /^-[a-zA-Z]*m./.test(word.text) && !word.text.startsWith("--") ? [word.text.slice(word.text.indexOf("m") + 1)] : []);
  if (module.some((one) => /(?:^|\.)cache_guard$/.test(one))) {
    return true;
  }
  const inline = args.findIndex((word) => word.text === "-c" || /^-[a-zA-Z]*c$/.test(word.text));
  if (inline >= 0 && /cache_guard/.test(args[inline + 1]?.text ?? "")) {
    return true;
  }
  const script = inline >= 0 || module.length > 0 ? undefined : operands(args, "WX")[0];
  return script !== undefined && basename2(script.text) === "cache_guard.py";
}
var basename2 = (path) => path.slice(path.lastIndexOf("/") + 1);
var isFilter = (segment) => ["head", "tail", "grep", "egrep", "rg", "less", "more"].includes(segment.program ?? "");
function filteredCheck(command, checks) {
  const text = command.trim();
  for (const check of checks) {
    const run = check.trim();
    if (run !== "" && text.startsWith(run)) {
      const after = text.slice(run.length);
      if (/^\s*(?:2>&1\s*)?\|&?/.test(after) && readings(after.replace(/^\s*(?:2>&1\s*)?\|&?/, "")).some((segments) => segments.some(isFilter))) {
        return run;
      }
    }
  }
  return null;
}
function judgeCommandAll(command, cfg, loop, where) {
  return unionBy(READINGS.flatMap((reading) => judgeIn(command, cfg, loop, where, reading)), (one) => JSON.stringify([one.rule, one.reason]));
}
function judgeIn(command, cfg, loop, where, reading) {
  const out = [];
  const segments = parseOf(command, where, reading);
  const links = lineLinks(segments, where);
  const lookup = lookupOf(segments, where, reading);
  const add = (verdict) => {
    if (verdict !== null && !out.some((one) => one.rule === verdict.rule && one.reason === verdict.reason)) {
      out.push(verdict);
    }
  };
  const prefixOf = (spelled, segment) => place(spelled.replace(/\/?[^/]*[*?[{].*$/, "") || ".", segment.cwd, where);
  for (const [i, segment] of segments.entries()) {
    for (const spelled of pathsOf(segment, where, reading)) {
      const reached = reach(spelled, segment, links[i] ?? [], where, lookup);
      if (reached.places.some((one) => isSecretPlace(one, cfg))) {
        add({ rule: "secret", reason: `${spelled} holds secrets; no command reads or writes it from here.` });
      }
      if (reached.isCapped) {
        add(deepReadRefusal(prefixOf(spelled, segment), cfg, where));
      }
    }
    for (const spelled of [...segment.readsDeep, ...segment.capped]) {
      for (const one of reach(spelled, segment, links[i] ?? [], where, lookup).places) {
        add(deepReadRefusal(isWild(one.spelled) || spelled.includes("{") ? prefixOf(one.spelled, segment) : one, cfg, where));
      }
    }
  }
  for (const segment of segments) {
    const destructive = destructiveAction(segment, where);
    if (destructive !== null) {
      add({
        rule: "destructive",
        reason: `${destructive.what}. Safer: ${destructive.safer}. If it really is needed, a person can allow this exact command for one turn: /devloop allow --command ${command.trim()}`
      });
    }
  }
  if (isPipeToShell(segments)) {
    add({ rule: "destructive", reason: `A download is run as code before anyone reads it. Safer: save it to a file (\`curl -fsSLo install.sh <url>\`), read it, then run it. If it really is needed, a person can allow this exact command for one turn: /devloop allow --command ${command.trim()}` });
  }
  for (const segment of segments) {
    if (runsCacheGuard(segment)) {
      add({ rule: "cache-guard", reason: "This runs cache-guard's own script (cache_guard.py), which edits the person's user settings and turns on opt-ins: a person runs it, through /devloop cache install|uninstall|doctor|report|status. Its test suite (python3 cache-guard/tests/test_cache_guard.py) and reading the file are fine." });
    }
    const action = productionAction(segment);
    if (action !== null) {
      add({ rule: "production", reason: `This command acts on production (${action}). Production changes are a person's to make, whatever the change's risk: stop and hand the command to the person.` });
    }
    const texts = [view(segment, true), view(segment, false)];
    const forbidden = cfg.forbidden.find((one) => texts.some((text) => new RegExp(one.pattern).test(text)));
    if (forbidden !== undefined) {
      add({ rule: "forbidden", reason: `devloop.json forbids this command (${forbidden.pattern}): ${forbidden.why}.` });
    }
    if (segment.program === "git" && isNoVerify(segment)) {
      add({ rule: "no-verify", reason: "The repository’s own hooks are not skipped: drop --no-verify (for commit, -n), and leave core.hooksPath alone." });
    }
    const notes = evidenceNotesWrite(segment, segments.slice(0, segments.indexOf(segment))) ?? notesPlumbingWrite(segment, command, segments);
    if (notes !== null) {
      add({ rule: "evidence-notes", reason: `${notes}: the portable evidence of a review is the harness's to write, never the builder's. A person pushes it themselves: git push origin ${EVIDENCE_REF}.` });
    }
    const hidden = segment.program === "git" ? hidesFromGit(segment) : null;
    if (hidden !== null) {
      add({ rule: "git-hidden", reason: `\`git update-index ${hidden}\` tells git to stop looking at a file's changes, so the gate and a push would no longer see what it holds. Leave the bit alone (clearing it, \`--no-${hidden.slice(2)}\`, is fine); if a file must not be committed, say so and let the person decide.` });
    }
    if (segment.program === "git" && isForcePush(segment)) {
      add({ rule: "force-push", reason: "A forced push is a person’s call; use --force-with-lease on your own branch or ask." });
    }
    if (cfg.network !== null) {
      const allow = cfg.network.allow;
      const host = segment.hosts.find((one) => !isAllowedHost(one, allow));
      if (host !== undefined) {
        add({ rule: "egress", reason: `${host} is not in devloop.json's network.allow, so commands do not reach it from here. If the work needs it, stop and ask the person to add it.` });
      }
    }
  }
  add(shipAloneIn(segments, where.branch, cfg.defaultBranch));
  add(shipElsewhereIn(segments, where, cfg.defaultBranch));
  const filtered = filteredCheck(command, cfg.verify.map((one) => one.run));
  if (filtered !== null) {
    const saved = where.savedOutput(filtered);
    add({
      rule: "check-filtered",
      reason: `\`${filtered}\` is one of the repository's checks: run it whole, so no failure is cut away.${saved !== null ? ` The harness saved the full output of its last run at ${saved}; read that file for any part of it.` : ""}`
    });
  }
  for (const verdict of where.tasks === undefined ? [] : tasksRefusalsIn(segments, where.tasks)) {
    add(verdict);
  }
  const isLocking = loop.phase === "spec" || loop.phase === "build";
  for (const [i, segment] of segments.entries()) {
    const lineLinksHere = links[i] ?? [];
    for (const spelled of segment.writes) {
      const reached = reach(spelled, segment, lineLinksHere, where, lookup);
      for (const placed of reached.places) {
        add(judgeWrite(placed, cfg, loop, where, true));
        if (where.tasks !== undefined && placed.rel !== null) {
          add(tasksShellWriteRefusal(placed.rel, where.tasks, where));
        }
        add(folderRefusal(placed, false, cfg, where));
      }
      if (reached.isCapped) {
        add({ rule: "protected", reason: `${spelled} matches more than ${GLOB_CAP} paths, so the harness cannot judge what this writes. Name the files to change, or a narrower pattern.` });
      }
    }
    if (segment.capped.length > 0 && (segment.writes.length > 0 || segment.isUnknown)) {
      add({ rule: "protected", reason: `${segment.capped[0] ?? ""} expands to more than ${GLOB_CAP} words, so the harness cannot judge what this writes. Name the files to change.` });
    }
    for (const spelled of segment.replaces) {
      for (const placed of reach(spelled, segment, lineLinksHere, where, lookup).places) {
        add(folderRefusal(placed, true, cfg, where));
      }
    }
    const dest = segment.writes[segment.writes.length - 1];
    if (dest !== undefined && ["cp", "mv", "rsync", "ln", "install"].includes(segment.program ?? "")) {
      const sources = segment.program === "mv" ? segment.replaces : segment.reads;
      for (const source of sources) {
        const name = source.replace(/\/+$/, "").slice(source.replace(/\/+$/, "").lastIndexOf("/") + 1);
        if (name !== "" && name !== "." && name !== ".." && !source.endsWith("/")) {
          add(folderRefusal(place(`${dest.replace(/\/+$/, "")}/${name}`, segment.cwd, where), false, cfg, where));
        }
      }
    }
    for (const spelled of segment.maybeWrites) {
      const placed = place(spelled, segment.cwd, where);
      if (placed.rel !== null && placed.rel !== "" && (where.filesUnder[placed.rel] ?? []).length > 0) {
        add(judgeWrite(placed, cfg, loop, where, true));
      }
    }
    for (const spelled of segment.isUnknown ? segment.named : []) {
      for (const placed of reach(spelled, segment, lineLinksHere, where, lookup).places) {
        const verdict = judgeWrite(placed, cfg, loop, where, false);
        add(verdict === null ? null : { ...verdict, reason: `${verdict.reason} The command's program is computed or runs inline code, so the harness cannot tell what it writes; if it only runs or reads, name the program literally (\`python3 -m pytest\`, not \`$PYTHON -m pytest\`).` });
      }
    }
    if (!segment.isFedByInput || !FED_WRITERS.includes(segment.program ?? "")) {
      continue;
    }
    const before = segments.filter((one) => one.pipeline === segment.pipeline && one.place < segment.place);
    for (const one of before) {
      const lister = listerRoots(one);
      if (lister === null) {
        for (const spelled of [...one.reads, ...operands(one.args).filter(isPathLike).map((word) => word.text)]) {
          add(judgeWrite(place(spelled, segment.cwd, where), cfg, loop, where, false));
        }
      } else if (isLocking) {
        for (const spelled of lister) {
          const verdict = judgeWrite(place(spelled, one.cwd, where), cfg, loop, where, false);
          add(verdict === null ? null : {
            ...verdict,
            reason: `\`${segment.program ?? ""}\` writes every file \`${one.program ?? ""}\` lists under ${spelled}, and locked files lie there: ${verdict.reason} Name the files to change on the command line, or use the edit tool.`
          });
        }
      }
    }
  }
  for (const segment of segments) {
    for (const verdict of removedTests(segment, cfg, loop, where)) {
      add(verdict);
    }
  }
  return out;
}
function removedTests(segment, cfg, loop, where) {
  const { program } = segment;
  const sub = program === "git" ? gitSub(segment.args).sub : null;
  const isDelete = ["rm", "unlink", "shred"].includes(program ?? "") || sub === "rm";
  const isMove = program === "mv" || sub === "mv";
  if (!isDelete && !isMove) {
    return [];
  }
  const isTestPath = (rel) => {
    const listed = where.filesUnder[rel];
    return listed !== undefined ? listed.some((file) => matchesAny(file, cfg.tests)) : matchesAny(rel, cfg.tests) || matchesAny(`${rel}/x`, cfg.tests);
  };
  let sources = segment.writes;
  let dest = null;
  if (isMove) {
    const target = program === "mv" ? flagValue(segment.args, "-t", "--target-directory") : null;
    dest = target ?? segment.writes[segment.writes.length - 1] ?? null;
    sources = target === null ? segment.writes.slice(0, -1) : segment.writes;
  }
  const out = [];
  for (const spelled of sources) {
    const placed = place(spelled, segment.cwd, where);
    const rel = placed.rel;
    if (rel === null || rel === "" || isExempt(rel, loop) || !isTestPath(rel)) {
      continue;
    }
    if (dest !== null) {
      const to = place(dest, segment.cwd, where).rel;
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      const landed = to === null ? null : sources.length > 1 || dest.endsWith("/") ? `${to}/${name}` : to;
      if (landed === null || matchesAny(landed, cfg.tests) || matchesAny(`${landed}/x`, cfg.tests)) {
        continue;
      }
    }
    out.push({
      rule: "test-weakened",
      reason: `${spelled} is a test${dest === null ? "; deleting it" : `; renaming it to ${dest} so it no longer runs as one`} removes what it checks. If the test is truly obsolete, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.`
    });
  }
  return out;
}
var FED_WRITERS = ["rm", "mv", "cp", "tee", "truncate", "shred", "unlink", "chmod", "sed", "perl"];
function listerRoots(segment) {
  const { program, args } = segment;
  const pathsOr = (paths) => {
    const named = paths.filter(isPathLike).map((word) => word.text);
    return named.length > 0 ? named : ["."];
  };
  if (program === "git") {
    const { sub, at } = gitSub(args);
    const rest = args.slice(at + 1);
    if (sub === "ls-files") {
      return pathsOr(operands(rest, "x", ["--exclude", "--exclude-from"]));
    }
    if (sub === "grep" && gitOption(rest, ["--files-with-matches", "--name-only"], "l") !== null) {
      const dash = rest.findIndex((word) => word.text === "--");
      return dash >= 0 ? pathsOr(rest.slice(dash + 1)) : ["."];
    }
    return null;
  }
  if ((program === "rg" || program === "grep" || program === "egrep" || program === "fgrep") && hasFlag(args, "l", ["--files-with-matches", "--files"])) {
    const hasPattern = args.some((word) => ["-e", "--regexp", "-f", "--file"].includes(word.text)) || hasFlag(args, null, ["--files"]);
    const said = operands(args, "efABCmgt", ["--regexp", "--file", "--glob", "--type", "--after-context", "--before-context", "--context", "--max-count"]);
    return pathsOr(hasPattern ? said : said.slice(1));
  }
  if (program === "find") {
    return segment.reads.length > 0 ? segment.reads : ["."];
  }
  if (program === "ls" || program === "fd" || program === "fdfind") {
    const said = operands(args, program === "ls" ? "IwT" : "edtEcj", ["--extension", "--type", "--exclude", "--max-depth", "--ignore", "--hide"]);
    return pathsOr(program === "ls" ? said : said.slice(1));
  }
  return null;
}
function writtenPaths(command, where) {
  return unionPlaces(writtenPathsByReading(command, where).flat());
}
function writtenPathsByReading(command, where) {
  return READINGS.map((reading) => writtenPathsIn(parseOf(command, where, reading), where, reading));
}
function writtenPathsIn(segments, where, reading) {
  const links = lineLinks(segments, where);
  const lookup = lookupOf(segments, where, reading);
  return segments.flatMap((segment, i) => [
    ...[...segment.writes, ...segment.maybeWrites, ...segment.isUnknown ? segment.named : []].flatMap((spelled) => reach(spelled, segment, links[i] ?? [], where, lookup).places),
    ...segment.isFedByInput && FED_WRITERS.includes(segment.program ?? "") ? segments.filter((one) => one.pipeline === segment.pipeline && one.place < segment.place).flatMap((one) => (listerRoots(one) ?? []).map((spelled) => place(spelled, one.cwd, where))) : []
  ]);
}
function namedPlacesByReading(command, where) {
  return READINGS.map((reading) => namedPlacesIn(parseOf(command, where, reading), where, reading));
}
function namedPlacesIn(segments, where, reading) {
  const links = lineLinks(segments, where);
  const lookup = lookupOf(segments, where, reading);
  return segments.flatMap((segment, i) => pathsOf(segment, where, reading).flatMap((spelled) => reach(spelled, segment, links[i] ?? [], where, lookup).places));
}
var READERS = {
  cat: [],
  head: [],
  tail: [],
  wc: [],
  nl: [],
  cut: [],
  jq: [],
  ls: [],
  diff: [],
  stat: [],
  file: [],
  grep: [],
  egrep: [],
  fgrep: [],
  rg: ["--pre", "--pre-glob"],
  sort: ["-o", "--output"],
  uniq: [],
  find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]
};
var GIT_READS = GIT_READS_BASE;
var GIT_WRITING = ["--output", "--output-directory", "--ext-diff", "--textconv", "-O", "--open-files-in-pager"];
function isReaderSegment(segment) {
  if (segment.isUnknown || segment.isNested || segment.writes.length > 0 || segment.wrappers.length > 0 || segment.assignments.length > 0) {
    return false;
  }
  if (segment.words.some((word) => word.hasExpansion) || segment.redirects.some((one) => one.isWrite)) {
    return false;
  }
  const refused = (names) => segment.args.some((word) => !word.isQuoted && names.some((name) => word.text === name || word.text.startsWith(`${name}=`) || name.length === 2 && word.text.startsWith(name) && !word.text.startsWith("--")));
  if (segment.program === "git") {
    const { sub, at } = gitSub(segment.args);
    const globals = segment.args.slice(0, at);
    if (globals.some((word) => isOptionNamed(word, ["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"]))) {
      return false;
    }
    return sub !== null && GIT_READS.includes(sub) && !gitOptionWords(segment.args.slice(at + 1)).some((word) => isOptionNamed(word, GIT_WRITING));
  }
  const program = segment.program;
  if (program === null) {
    return false;
  }
  const writing = READERS[program];
  return writing !== undefined && !refused(writing) && (program !== "uniq" || operands(segment.args, "fsw").length <= 1);
}
function tierOf(files, cfg, hasTouchedTests, spec = null) {
  const counted = spec === null ? files : files.filter((file) => !file.startsWith(`specs/${spec}/`));
  if (counted.length === 0) {
    return files.length === 0 ? "none" : "low";
  }
  if (counted.some((file) => matchesAny(file, cfg.tiers.high) || matchesAny(file, cfg.protected) || matchesAny(file, BUILTIN_PROTECTED) || matchesAny(file, instructionGlobs(cfg)))) {
    return "high";
  }
  const isAllLow = counted.every((file) => matchesAny(file, cfg.tiers.low) && !matchesAny(file, cfg.tests));
  return isAllLow && !hasTouchedTests ? "low" : "medium";
}
function lintCheck(run) {
  const found = [];
  if (/\|\|\s*(?:true|:)(?=$|[\s;)&|])/.test(run)) {
    found.push("`|| true` turns any failure into a pass");
  }
  if (/(?:;|\|\||&&)\s*exit\s+0\b/.test(run)) {
    found.push("`exit 0` makes it pass whatever ran before");
  }
  if (/--passWithNoTests\b/.test(run)) {
    found.push("`--passWithNoTests` passes when no test runs");
  }
  for (const segments of readings(run)) {
    const isPiped = segments.some((one) => one.place > 0 && !one.isNested);
    if (isPiped && segments.some((one) => one.place > 0 && isFilter(one))) {
      found.push("its output goes through head, tail or grep, which can hide the failure and its exit code");
    } else if (isPiped && !/pipefail/.test(run)) {
      found.push("a pipe without `set -o pipefail` reports only the last command's exit code");
    }
  }
  return [...new Set(found)];
}
var lintChecks = (steps) => steps.flatMap((one) => lintCheck(one.run).map((problem) => `\`${one.run}\`: ${problem}`));
var isApplying = (step, changed) => step.when === null || changed.some((file) => matchesAny(file, step.when ?? []));
function stepsFor(steps, profile, changed) {
  return steps.filter((one) => one.background !== true && (profile === "full" || one.profile === "fast") && isApplying(one, changed));
}
var backgroundFor = (steps, changed) => steps.filter((one) => one.background === true && isApplying(one, changed));

// hooks/contentrules.ts
function addedLines(before, after) {
  const left = new Map;
  for (const line of before.split(`
`)) {
    left.set(line, (left.get(line) ?? 0) + 1);
  }
  const out = [];
  for (const line of after.split(`
`)) {
    const n = left.get(line) ?? 0;
    if (n > 0) {
      left.set(line, n - 1);
    } else {
      out.push(line);
    }
  }
  return out;
}
var markerOf = (id) => new RegExp(`devloop-allow:\\s*${id.replace(/[-]/g, "\\-")}\\s+\\S`);
function isMatch2(rule, line) {
  try {
    return new RegExp(rule.pattern).test(line);
  } catch {
    return false;
  }
}
function countUnmarked(rule, text) {
  const lines = text.split(`
`);
  const marker = markerOf(rule.id);
  const above = (i) => i > 0 && marker.test(lines[i - 1] ?? "") && !isMatch2(rule, lines[i - 1] ?? "");
  return lines.filter((line, i) => isMatch2(rule, line) && !marker.test(line) && !above(i)).length;
}
var rulesFor = (path, rules) => rules.filter((rule) => matchesAny(path, rule.when));
function judgeContent(path, before, after, rules, skip = []) {
  const out = [];
  const added = addedLines(before, after);
  const afterLines = after.split(`
`);
  const lineNo = (line) => line === undefined ? 0 : afterLines.indexOf(line) + 1;
  for (const rule of rulesFor(path, rules)) {
    if (skip.includes(rule.id)) {
      continue;
    }
    if (rule.action === "ratchet") {
      const was = countUnmarked(rule, before);
      const now = countUnmarked(rule, after);
      const line = added.find((one) => isMatch2(rule, one));
      out.push({ rule, verdict: now > was ? "refuse" : "note", line: (line ?? "").trim().slice(0, 160), lineNo: lineNo(line), before: was, after: now });
      continue;
    }
    const line = added.find((one) => isMatch2(rule, one));
    if (line !== undefined) {
      out.push({ rule, verdict: rule.action === "refuse" ? "refuse" : "note", line: line.trim().slice(0, 160), lineNo: lineNo(line) });
    }
  }
  return out;
}
function contentReason(hit, path) {
  const { rule } = hit;
  if (rule.action === "ratchet") {
    return `devloop.json's ratchet "${rule.id}" (${rule.why}): this edit raises the count of \`${rule.pattern}\` in ${path} from ${hit.before ?? 0} to ${hit.after ?? 0}. A change may lower the count, never raise it. To keep a match on purpose, put \`devloop-allow: ${rule.id} <reason>\` on its line or the line above.`;
  }
  return `devloop.json's rule "${rule.id}" refuses this line in ${path} (${rule.why}): ${hit.line}`;
}

// hooks/findings.ts
var openBlocking = (findings, reviewer) => findings.filter((one) => one.status === "open" && one.isBlocking && (reviewer === undefined || one.reviewer === reviewer));

// hooks/output.ts
var ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
var stripAnsi = (text) => text.replace(ANSI, "");
function tail(text, lines = 40, chars = 4000) {
  const kept = text.trimEnd().split(`
`).slice(-lines).join(`
`);
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
}
var ERROR = /\berror\b|\bFAIL(ED)?\b|Error:|panicked|Traceback/i;
var RUNTIME_FRAME = /^\s*at\s.*(?:\(node:|\bnode:internal\/)|^\s*at node:|^\s*File "<frozen [^>]*>"|^\s*(?:async\s+)?[\w$.<>[\]]+(?:\s\[as [\w$]+\])?\s\(node:[^)]*\)\s*$|^\s*(?:async\s+)?node:internal\//;
function distill(text, errorLines = 12, tailLines = 30, chars = 4000) {
  const lines = stripAnsi(text).trimEnd().split(`
`).filter((line) => !RUNTIME_FRAME.test(line));
  const from = Math.max(0, lines.length - tailLines);
  const errors = lines.slice(0, from).filter((line) => ERROR.test(line)).slice(0, errorLines);
  const end = tail(lines.slice(from).join(`
`), tailLines, errors.length > 0 ? Math.floor(chars / 2) : chars);
  if (errors.length === 0) {
    return end;
  }
  const head = errors.join(`
`);
  return `${head.length > chars / 2 ? `${head.slice(0, chars / 2)}…` : head}
…
${end}`;
}
function hash(text) {
  let a = 3735928559;
  let b = 1103547991;
  for (let i = 0;i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ a >>> 16, 2246822507) ^ Math.imul(b ^ b >>> 13, 3266489909);
  b = Math.imul(b ^ b >>> 16, 2246822507) ^ Math.imul(a ^ a >>> 13, 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, "0");
}
var digest = (text) => hash(text);
function classify(code, _output = "") {
  if (code === 0) {
    return "pass";
  }
  if (code === 127 || code === 126) {
    return "not-found";
  }
  if (code === 124 || code < 0) {
    return "timeout";
  }
  if ([130, 134, 137, 143].includes(code)) {
    return "killed";
  }
  return "fail";
}
function infraAdvice(command, outcome, timeoutSec, isBackground = false) {
  switch (outcome) {
    case "not-found":
      return `\`${command}\` could not run: its program was not found (exit 127). Install it, or fix the command in devloop.json; no code change fixes this.`;
    case "timeout":
      if (isBackground) {
        return `\`${command}\` stopped before it finished (exit 124: its own time limit, not devloop's). Check the command's own timeout; no code change to the work fixes this.`;
      }
      return `\`${command}\` did not finish within ${timeoutSec}s, so devloop stopped waiting. Mark it "background": true in devloop.json: it then runs without holding anyone up, with no time limit. No code change to the work fixes this.`;
    case "killed":
      return `\`${command}\` was killed before it finished (out of memory, or stopped by the system). Free resources or rerun it; no code change to the work fixes this.`;
    default:
      return "";
  }
}

// hooks/testruns.ts
function ago(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) {
    return "<1m";
  }
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function runningOn(loop, run) {
  const one = loop.background?.[run];
  return one !== undefined && loop.tree !== null && one.tree === loop.tree ? one : null;
}
function recordOn(loop, run) {
  const one = loop.verify.runs?.[run];
  return one !== undefined && loop.tree !== null && one.tree === loop.tree && !one.isOlderTree ? one : null;
}

// hooks/gate.ts
var ORDER = ["none", "low", "medium", "high"];
var raise = (tier) => tier === "none" ? "none" : ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + 1)] ?? "high";
function blastReasons(changed, lines, cfg) {
  const out = [];
  const { maxFiles, maxLines, manifests } = cfg.blastRadius;
  if (changed.length > maxFiles) {
    out.push(`${changed.length} files changed, over the ${maxFiles} blastRadius.maxFiles allows`);
  }
  if (lines > maxLines) {
    out.push(`${lines} lines changed, over the ${maxLines} blastRadius.maxLines allows`);
  }
  const touched = changed.filter((file) => matchesAny(file, manifests));
  if (touched.length > 0) {
    out.push(`a dependency manifest changed (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""})`);
  }
  return out;
}
function tierWithBlast(files, lines, cfg, spec = null) {
  const tier = tierOf(files, cfg, files.some((file) => matchesAny(file, cfg.tests)), spec);
  return blastReasons(files, lines, cfg).length > 0 ? raise(tier) : tier;
}
var tierFor = (loop, cfg) => tierWithBlast(loop.changed, loop.size.lines, cfg, loop.spec);
function featureCounts(loop) {
  const all = Object.values(loop.features);
  const passing = all.filter((one) => one.passes);
  return { total: all.length, passing: passing.length, onTree: passing.filter((one) => one.tree === loop.tree).length };
}
function verdictCovers(input) {
  if (input.verdict === null || input.now === null) {
    return "not";
  }
  if (input.verdict === input.now) {
    return "reviewed";
  }
  return input.isOn && input.isValid && input.diff !== null && isTaskStateOnly(input.diff) ? "carried" : "not";
}
var carryKey = (from, to) => `${from} ${to}`;
function coverageOf(loop, facts) {
  const from = loop.review.tree;
  const fact = from === null || loop.tree === null ? undefined : facts.carry?.[carryKey(from, loop.tree)];
  return verdictCovers({ verdict: from, now: loop.tree, diff: fact?.paths ?? null, isOn: fact !== undefined, isValid: fact?.isValid ?? false });
}
function verdictFails(loop, coverage) {
  const fails = loop.checklistFails ?? [];
  return fails.filter((one) => one.tree === loop.tree || coverage !== "not" && one.tree !== null && one.tree === loop.review.tree);
}
var NO_FACTS = { errors: [], lint: [], policy: "same" };
var short = (tree) => (tree ?? "none").slice(0, 8);
var list = (items, cap = 5) => `${items.slice(0, cap).join(", ")}${items.length > cap ? ", …" : ""}`;
var specialistsFor = (loop, cfg) => cfg.reviewers.filter((one) => loop.changed.some((file) => one.when.some((glob) => matches(file, glob))));
function verificationRow(loop, cfg, tier, facts) {
  const label = "Verification";
  if (loop.verify.status === "error") {
    return { label, isMet: false, note: `the harness could not verify (${loop.verify.failed ?? "unknown error"}); /devloop verify retries` };
  }
  if (tier === "none") {
    return { label, isMet: true, note: "no changes yet" };
  }
  if (cfg.verify.length === 0) {
    return { label, isMet: tier === "low", note: "no verify commands in devloop.json: nothing proves the work" };
  }
  const foreground = stepsFor(cfg.verify, "full", loop.changed);
  const background = facts.isStateless === true ? [] : backgroundFor(cfg.verify, loop.changed);
  const steps = [...foreground, ...background];
  if (loop.tree === null && background.length > 0) {
    return { label, isMet: false, note: `background checks need a git repository to record a result against: ${list(background.map((one) => one.run))}` };
  }
  const isMoved = loop.isDirty && loop.verify.status === "pass";
  const pending = steps.filter((one) => isMoved || loop.tree === null || loop.verify.passedOn[one.run] !== loop.tree);
  const isOnTree = loop.verify.tree === loop.tree && !isMoved;
  if (loop.verify.status === "fail" && isOnTree && loop.verify.failed !== null) {
    return loop.verify.infra !== null ? { label, isMet: false, note: `could not run: ${loop.verify.failed} (${loop.verify.infra})` } : { label, isMet: false, note: `failing: ${loop.verify.failed}` };
  }
  if (loop.tree === null) {
    const hasPassed = loop.verify.status === "pass" && !loop.isDirty;
    const needsFull = foreground.some((one) => one.profile === "full");
    const isMet = hasPassed && (loop.verify.profile === "full" || !needsFull);
    return {
      label,
      isMet,
      note: isMet ? needsFull ? "fast and full checks pass" : "passes" : hasPassed ? "fast checks pass; the full checks run when the change ships" : "not run since the last edit"
    };
  }
  const hasFull = foreground.some((one) => one.profile === "full");
  if (pending.length === 0) {
    return { label, isMet: true, note: hasFull ? "fast and full checks pass" : steps.length === 0 ? "no check applies to this change" : "passes" };
  }
  const names = pending.map((one) => one.run);
  const waiting = isMoved ? [] : pending.filter((one) => one.background === true).map((one) => one.run);
  const running = waiting.flatMap((run) => {
    const one = runningOn(loop, run);
    return one === null ? [] : [{ run, startedAt: one.startedAt }];
  });
  if (running.length > 0) {
    const since = facts.now === undefined ? "" : ` (started ${ago(facts.now - Math.min(...running.map((one) => one.startedAt)))} ago)`;
    return { label, isMet: false, note: `tests still running${since}: ${list(running.map((one) => one.run))}` };
  }
  const failing = waiting.filter((run) => recordOn(loop, run)?.outcome === "fail");
  if (failing.length > 0) {
    return { label, isMet: false, note: `failing: ${list(failing)} (in the background)` };
  }
  const couldNot = waiting.flatMap((run) => {
    const outcome = recordOn(loop, run)?.outcome;
    return outcome === undefined || outcome === "pass" || outcome === "fail" ? [] : [`${run} (${outcome})`];
  });
  if (couldNot.length > 0) {
    return { label, isMet: false, note: `could not run on this tree: ${list(couldNot)}; fix the command` };
  }
  if (pending.every((one) => one.background === true)) {
    const done = foreground.length === 0 ? "" : hasFull ? "fast and full checks pass; " : "fast checks pass; ";
    return { label, isMet: false, note: `${done}background checks still to run: ${list(names)} (they start at the next stop)` };
  }
  const isFastDone = pending.every((one) => one.profile === "full" || one.background === true);
  return {
    label,
    isMet: false,
    note: isFastDone ? `fast checks pass; the full checks run when the change ships: still to run ${list(names)}` : `not run since the last edit; still to run: ${list(names)}`
  };
}
function reviewRow(loop, cfg, name, label, rows, facts) {
  const { review } = loop;
  const coverage = coverageOf(loop, facts);
  const isCarried = coverage === "carried";
  const isOnTree = coverage !== "not";
  const isDone = review.status === "pass" || review.status === "fail";
  const open = openBlocking(loop.findings).filter((one) => one.reviewer === name || name === "general" && !rows.includes(one.reviewer));
  const decisions = open.filter((one) => one.route === "decision");
  if (decisions.length > 0) {
    return {
      label,
      isMet: false,
      note: `${decisions.map((one) => one.id).join(", ")} await${decisions.length === 1 ? "s" : ""} a person's decision: /devloop findings resolve <id> <note>${open.length > decisions.length ? `; ${open.length - decisions.length} more to fix` : ""}`
    };
  }
  if (review.isStalled && open.length > 0) {
    return { label, isMet: false, note: `stopped: two rounds in a row closed no finding (${open.map((one) => one.id).join(", ")} open), so a person reads the change` };
  }
  if (isDone && isOnTree && name !== "general" && !review.agents.some((one) => one.name === name)) {
    return { label, isMet: false, note: `did not run in round ${review.round}: /devloop review starts a round with it` };
  }
  if (isDone && isOnTree) {
    const notes = loop.findings.filter((one) => one.reviewer === name && (one.status === "note" || one.status === "deferred") && one.seen === review.round).length;
    const failed = name === "general" ? verdictFails(loop, coverage).filter((one) => one.tree === review.tree).map((one) => one.ref) : [];
    if (open.length === 0 && failed.length > 0) {
      return { label, isMet: false, note: `a failing verdict: round ${review.round}${isCarried ? ` (on ${short(review.tree)}, carried: only task state has changed since)` : ""} left promoted checklist items failing on the tree it read: ${list(failed)}` };
    }
    return open.length === 0 ? { label, isMet: true, note: isCarried ? `passed on ${short(review.tree)}; only task state has changed since` : `passed in round ${review.round}${notes > 0 ? ` (${notes} note${notes === 1 ? "" : "s"}, nothing blocking)` : ""}` } : { label, isMet: false, note: `round ${review.round} of ${cfg.maxReviewRounds} found problems: ${open.map((one) => one.id).join(", ")} open` };
  }
  const next = cfg.autoReview ? "a new round starts when the change is ready (the devloop_review tool, or a push)" : 'a person starts a new round with /devloop review ("autoReview" is off)';
  const stale = `passed on tree ${short(review.tree)}, but the tree is now ${short(loop.tree)}: the review is out of date, and ${next}`;
  if (isDone) {
    return { label, isMet: false, note: review.status === "pass" ? stale : `reviewed on tree ${short(review.tree)}, but the tree is now ${short(loop.tree)}` };
  }
  if (review.status === "running") {
    return { label, isMet: false, note: `round ${review.round} running` };
  }
  if (isCapSpent(review, cfg)) {
    return { label, isMet: false, note: `the cap of ${cfg.maxReviewRounds} rounds is spent: a person reads the change` };
  }
  return { label, isMet: false, note: review.cycle.ended === "pass" && review.tree !== null && review.tree !== loop.tree ? stale : "not run: /devloop review" };
}
var isCapSpent = (review, cfg) => review.round >= cfg.maxReviewRounds && review.cycle.ended !== "pass";
function gate(loop, cfg, facts = NO_FACTS) {
  const checks = [];
  const tier = tierFor(loop, cfg);
  if (facts.errors.length > 0) {
    checks.push({ label: "Policy error", isMet: false, note: `devloop.json: ${facts.errors.slice(0, 3).join("; ")}${facts.errors.length > 3 ? "; …" : ""}` });
  }
  if (!loop.isBaseKnown && loop.tree !== null) {
    checks.push({ label: "Base branch unknown", isMet: false, note: 'no branch to measure the change against: set "defaultBranch" in devloop.json (/devloop doctor says which exist)' });
  }
  const hiddenFromGit = facts.hiddenFromGit ?? [];
  if (hiddenFromGit.length > 0) {
    checks.push({ label: "Files hidden from git", isMet: false, note: `${list(hiddenFromGit)} carr${hiddenFromGit.length === 1 ? "ies" : "y"} the skip-worktree or assume-unchanged bit, so their changes are not in the tree judged: clear it (git update-index --no-skip-worktree --no-assume-unchanged <file>)` });
  }
  checks.push(verificationRow(loop, cfg, tier, facts));
  if (loop.phase === "spec") {
    checks.push({ label: "Spec", isMet: false, note: "awaiting a person: /devloop approve" });
  }
  if (loop.phase === "build") {
    const { passing, total, onTree } = featureCounts(loop);
    checks.push({
      label: "Features",
      isMet: passing === total && onTree === total,
      note: `${passing}/${total} passing${passing > 0 && onTree < passing ? `; ${onTree} of those passes cover this tree (the rest are re-run before review and shipping)` : ""}`
    });
    checks.push(loop.testHashes === null ? { label: "Tests unchanged since approval", isMet: false, note: "no record of the tests at approval (git could not list them): a person reopens the spec (/devloop spec) and approves it again" } : testsRow(loop));
  }
  const regressions = Object.entries(loop.regressions ?? {});
  if (regressions.length > 0 && tier !== "none") {
    checks.push(regressionRow(loop, regressions));
  }
  for (const one of verdictFails(loop, coverageOf(loop, facts))) {
    checks.push({ label: `Checklist: ${one.ref}`, isMet: false, note: one.tree === loop.tree ? one.note : `failed on the reviewed tree ${short(one.tree)}, and the verdict carries here: ${one.note.replace(/^failed on this tree /, "")}` });
  }
  const evidence = loop.evidence;
  const isScanned = evidence.tree === loop.tree;
  const blocking = specialistsFor(loop, cfg).filter((each) => each.mode === "blocking");
  const rows = ["general", ...blocking.map((one) => one.name)];
  if (atLeast(tier, "medium")) {
    checks.push(reviewRow(loop, cfg, "general", "Independent review", rows, facts));
    for (const one of blocking) {
      checks.push(reviewRow(loop, cfg, one.name, `Review: ${one.name}`, rows, facts));
    }
  } else if (openBlocking(loop.findings).length > 0) {
    checks.push(reviewRow(loop, cfg, "general", "Independent review", ["general"], facts));
  }
  if (tier !== "none") {
    const hits = evidence.credentials;
    const isOutside = loop.tree === null;
    checks.push({
      label: "No credentials in the diff",
      isMet: isOutside ? !atLeast(tier, "medium") : isScanned && hits.length === 0,
      note: isOutside ? "not scanned: this is not a git repository, so there is no diff to scan" : !isScanned ? "not scanned on this tree yet: the scan runs with verification" : hits.length === 0 ? "no key or token shapes in the added lines" : `${list(hits.map((one) => `${one.file}:${one.line} (${one.kind})`))}: remove it and rotate it; the value is not shown`
    });
  }
  if (loop.changed.some((file) => matchesAny(file, cfg.tests))) {
    checks.push({ label: "Tests changed", isMet: true, note: "a person should read the test diff first" });
  }
  for (const file of loop.assertionDrops) {
    checks.push({ label: `Assertions removed in ${file}`, isMet: true, note: "an edit left the file with fewer assertions: a person should read why" });
  }
  if (loop.approval !== null && loop.approval.vacuous.length > 0) {
    checks.push({ label: "Vacuous checks at approval", isMet: true, note: `${list(loop.approval.vacuous)} already passed before any implementation; a person approved them as they were` });
  }
  const instructions = loop.changed.filter((file) => matchesAny(file, instructionGlobs(cfg)));
  if (instructions.length > 0) {
    const hidden = isScanned ? evidence.hidden.filter((one) => instructions.includes(one.file)) : [];
    checks.push({
      label: "Instruction files changed",
      isMet: hidden.length === 0,
      note: hidden.length > 0 ? `${list(hidden.map((one) => `${one.file}:${one.line} (${one.kind === "bidi" ? "a bidirectional override" : "invisible characters"})`))}: text a reader cannot see; remove it, then a person reads the file` : `a person must read ${list(instructions)}: every later session reads them`
    });
  }
  const blast = blastReasons(loop.changed, loop.size.lines, cfg);
  if (blast.length > 0 && tier !== "none") {
    checks.push({ label: "Blast radius", isMet: true, note: `${blast.join("; ")}: the change is one tier riskier (${tier})` });
  }
  if (facts.policy === "changed") {
    const mode = facts.workingMode === undefined || facts.workingMode === null ? "" : `; it sets "mode": "${facts.workingMode}", but the base branch's "${cfg.mode}" is in force`;
    checks.push({ label: "Policy changed in this change", isMet: true, note: `devloop.json differs from the base branch; the gate judges by the base branch's copy until this merges, and a person must read the change${mode}` });
  } else if (facts.policy === "deleted") {
    checks.push({ label: "Policy changed in this change", isMet: true, note: "devloop.json was deleted; the base branch's copy stays in force for every decision until this merges, and a person must read the change" });
  } else if (facts.policy === "no-base") {
    checks.push({ label: "Policy", isMet: true, note: "no devloop.json on the base branch, so the gate uses the working tree's copy (for every decision, not only the gate)" });
  }
  if (facts.ignoredCapped !== undefined && facts.ignoredCapped !== null) {
    checks.push({ label: "Ignored instruction files", isMet: true, note: `${facts.ignoredCapped} instruction files git ignores matched; only the first 500 (the shallowest) are in the verified tree. Add the folders that hold the rest to "instructionsIgnore", or a person reads them` });
  }
  if (facts.lint.length > 0) {
    checks.push({ label: "Check integrity", isMet: true, note: facts.lint.join("; ") });
  }
  if (cfg.checkEnv.mode === "observe" && (facts.exposed ?? []).length > 0 && tier !== "none") {
    const count = (facts.exposed ?? []).length;
    checks.push({ label: "Check environment", isMet: true, note: `checks could see ${count} credential-shaped variable${count === 1 ? "" : "s"}; /devloop doctor lists them` });
  }
  return checks;
}
function regressionRow(loop, regressions) {
  const label = "Regression checks";
  const onTree = (one) => one.tree === loop.tree;
  const failing = regressions.filter(([, one]) => one.passes === false && onTree(one));
  if (failing.length > 0) {
    return { label, isMet: false, note: `failing: ${list(failing.map(([id, one]) => `${id} (from ${one.change}, spec "${one.spec}", closed ${new Date(one.closedAt).toISOString().slice(0, 10)})`), 3)}` };
  }
  const pending = regressions.filter(([, one]) => one.passes !== true || !onTree(one));
  if (pending.length > 0) {
    return { label, isMet: false, note: `${pending.length} of ${regressions.length} not run on this tree: they run with the full checks when the change ships (${list(pending.map(([id]) => id), 3)})` };
  }
  return { label, isMet: true, note: `${regressions.length} pass on this tree` };
}
function testsRow(loop) {
  const label = "Tests unchanged since approval";
  const { evidence } = loop;
  if (evidence.tree !== loop.tree) {
    return { label, isMet: false, note: "not checked on this tree yet: it is checked with verification" };
  }
  const exempted = (file) => loop.exemptionsUsed.some((glob) => matches(file, glob));
  const covered = evidence.testsChanged.filter(exempted);
  const uncovered = evidence.testsChanged.filter((file) => !exempted(file));
  const parts = [
    uncovered.length > 0 ? `changed since approval: ${list(uncovered)}` : "no approved test changed",
    covered.length > 0 ? `changed under a person's exemption: ${list(covered)}` : "",
    evidence.testsAdded.length > 0 ? `new test files: ${list(evidence.testsAdded)}` : ""
  ];
  return { label, isMet: uncovered.length === 0, note: parts.filter((one) => one !== "").join("; ") };
}
var RANK = { none: 0, low: 1, medium: 2, high: 3 };
var atLeast = (tier, floor) => RANK[tier] >= RANK[floor];
var approvalsFor = (tier, cfg) => tier === "none" ? 0 : cfg.approvals[tier];
function approvers(tier, cfg) {
  const n = approvalsFor(tier, cfg);
  return n === 0 ? "merge once the gate is green" : n === 1 ? "one person other than the author approves and merges" : `${n === 2 ? "two" : n} people approve and merge`;
}

// hooks/weaken.ts
var AT_START = "(?<![\\w.$])";
var SKIPS = [
  new RegExp(`${AT_START}(?:it|test|describe|context|suite|specify)\\.(?:skip|only|todo|failing)\\b`, "g"),
  new RegExp(`${AT_START}x(?:it|test|describe|context|specify)\\s*\\(`, "g"),
  new RegExp(`${AT_START}f(?:it|describe)\\s*\\(`, "g"),
  new RegExp(`${AT_START}pytest\\.mark\\.(?:skip|skipif|xfail)\\b`, "g"),
  new RegExp(`${AT_START}pytest\\.(?:skip|xfail|importorskip)\\s*\\(`, "g"),
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
  /\braise\s+(?:unittest\.)?SkipTest\b/g,
  new RegExp(`${AT_START}t\\.Skip(?:f|Now)?\\s*\\(`, "g"),
  /#\[ignore\b/g,
  /@(?:Disabled|Ignore)\b/g
];
function overrides(text) {
  return /\bfunc\s+TestMain\s*\(/.test(text) && !/\.Run\s*\(\s*\)/.test(text) ? 1 : 0;
}
var ASSERTIONS = [
  /\bexpect\s*[(.]/g,
  /\bassert(?:_\w+|[A-Z]\w*)?!?\s*\(/g,
  /^\s*assert\s+\S/gm,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\.should\b/g
];
var count = (text, patterns) => patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
var countMarkers = (text) => ({ skips: count(text, SKIPS) + overrides(text), assertions: count(text, ASSERTIONS) });
function judgeTestEdit(before, after) {
  const was = countMarkers(before);
  const now = countMarkers(after);
  return {
    isWeakened: now.skips > was.skips,
    isAssertionDrop: now.assertions < was.assertions,
    isEmptied: before.trim() !== "" && after.trim() === "",
    before: was,
    after: now
  };
}
function editedText(before, input) {
  if (input.tool === "Write") {
    return typeof input.content === "string" ? input.content : null;
  }
  if (input.tool !== "Edit" || typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    return null;
  }
  if (input.old_string === "") {
    return input.new_string;
  }
  if (!before.includes(input.old_string)) {
    return null;
  }
  return input.replace_all === true ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string);
}

// hooks/enforce.ts
var STATE_FALLBACK = "/tmp/devloop-state";
var stateRootFrom = (data) => data === undefined || data === null || data === "" ? STATE_FALLBACK : data.replace(/\/+$/, "");
var repoStateDir = (stateRoot, root) => `${stateRoot}/repos/${digest(root)}`;
var part = (id) => /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : digest(id);
var stampPath = (stateRoot, toolUseId) => `${stateRoot}/stamps/calls/${part(toolUseId)}`;
var STAMPS_KEPT = 300;
var heartbeatPath = (stateRoot, sessionId) => `${stateRoot}/stamps/live/${part(sessionId)}`;
var stopStampPath = (stateRoot, sessionId) => `${stateRoot}/stamps/stops/${part(sessionId)}`;
var promptStampPath = (stateRoot, sessionId) => `${stateRoot}/stamps/prompts/${part(sessionId)}`;
var noticePath = (stateRoot, sessionId) => `${stateRoot}/stamps/notices/${part(sessionId)}`;
function stopKey(input) {
  const text = (value) => typeof value === "string" ? value : "";
  return digest([text(input.session_id), text(input.prompt_id), text(input.last_assistant_message), input.stop_hook_active === true ? "1" : "0"].join(`
`));
}
var inboxPath = (stateRoot, root) => `${repoStateDir(stateRoot, root)}/classic-inbox.jsonl`;
var statelessLoop = (phase = "idle") => ({ ...FRESH, phase });
function isSecretPattern(pattern, cwd, where, cfg) {
  const name = pattern.slice(pattern.lastIndexOf("/") + 1);
  const bare = name.replace(/[*?[\]{}]/g, "");
  return [pattern, bare].some((one) => one !== "" && isSecretPlace(place(one, cwd, where), cfg));
}
var EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
var FILE_TOOLS = ["Read", ...EDIT_TOOLS];
var SEARCH_TOOLS = ["Grep", "Glob"];
var SHELL_TOOLS = ["Bash", "Monitor"];
var JUDGED_TOOLS = [...FILE_TOOLS, ...SEARCH_TOOLS, ...SHELL_TOOLS];
var textOf = (input, key) => typeof input[key] === "string" ? input[key] : "";
var filePathOf = (call) => textOf(call.input, call.tool === "NotebookEdit" ? "notebook_path" : "file_path");
var commandOf = (call) => textOf(call.input, "command");
function judgeCall(call, facts) {
  const { cfg, where, loop, isOptedIn } = facts;
  const out = [];
  const tool = call.tool;
  if (FILE_TOOLS.includes(tool)) {
    const file = filePathOf(call);
    const spelled = place(file, where.cwd, where);
    const placed = [spelled, ...facts.realOf(spelled)];
    if (placed.some((one) => isSecretPlace(one, cfg))) {
      out.push({ rule: "secret", reason: `${file} holds secrets; it is never read or written from here.` });
    }
    if (tool === "Read") {
      return out;
    }
    const state = placed.find((one) => isHarnessState(one, where));
    if (state !== undefined) {
      out.push({ rule: "harness-state", reason: harnessStateReason({ ...state, spelled: file }) });
    }
    if (!isOptedIn) {
      return out.filter((one) => one.rule === "secret");
    }
    const asFile = (one) => one.rel === null ? where : { ...where, folders: { ...where.folders, [one.rel]: false } };
    for (const one of placed) {
      const verdict = judgeWrite(one, cfg, loop, asFile(one));
      if (verdict !== null && verdict.rule !== "secret") {
        out.push(verdict);
      }
    }
    const rel = spelled.rel ?? "";
    const before = tool === "NotebookEdit" || spelled.abs === null ? null : facts.readText(spelled.abs);
    const after = tool === "NotebookEdit" ? null : editedText(before ?? "", { ...call.input, tool });
    const tasks = tool === "NotebookEdit" || where.tasks === undefined ? null : tasksEditRefusalOf(placed, before, after, where.tasks);
    if (tasks !== null) {
      out.push(tasks);
    }
    if (tool !== "NotebookEdit" && rel !== "") {
      if (matchesAny(rel, cfg.tests) && after !== null) {
        const edit = judgeTestEdit(before ?? "", after);
        if (edit.isWeakened) {
          out.push({ rule: "test-weakened", reason: `This edit ${before !== null ? "adds" : "creates a test file with"} skip, only, todo or xfail markers ${before !== null ? "to" : "in"} ${rel} (${edit.before.skips} before, ${edit.after.skips} after), which switches tests off. Make the code pass the test instead. If the test is truly wrong, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` });
        } else if (edit.isEmptied) {
          out.push({ rule: "test-weakened", reason: `This edit empties ${rel}, which deletes its tests. If the test is truly obsolete, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` });
        }
      }
      if (after !== null && rulesFor(rel, cfg.rules).length > 0) {
        for (const one of judgeContent(rel, before ?? "", after, cfg.rules).filter((each) => each.verdict === "refuse")) {
          out.push({ rule: "content-rule", id: one.rule.id, reason: contentReason(one, rel) });
        }
      }
    }
    return out;
  }
  if (SEARCH_TOOLS.includes(tool)) {
    const named = [textOf(call.input, "path"), tool === "Glob" ? textOf(call.input, "pattern") : textOf(call.input, "glob")].filter((one) => one !== "");
    if (named.some((one) => isSecretPattern(one, where.cwd, where, cfg))) {
      out.push({ rule: "secret", reason: "This search targets secret files; they are never read from here." });
    }
    const path = textOf(call.input, "path");
    if (path !== "") {
      if (facts.realOf(place(path, where.cwd, where)).some((real) => isSecretPlace(real, cfg))) {
        out.push({ rule: "secret", reason: `${path} leads to files that hold secrets; they are never read from here.` });
      }
    }
    return out;
  }
  if (SHELL_TOOLS.includes(tool)) {
    const text = commandOf(call);
    let found = judgeCommandAll(text, cfg, isOptedIn ? loop : { ...loop, phase: "idle", spec: null }, where);
    for (const one of followedPlaces(namedPlacesByReading(text, where), LINK_BUDGET)) {
      if (facts.realOf(one).some((real) => isSecretPlace(real, cfg))) {
        found.push({ rule: "secret", reason: `${one.spelled} leads to a file that holds secrets; no command reads or writes it from here.` });
      }
    }
    found.push(...budgetRefusals(text, where, isOptedIn));
    if (isOptedIn) {
      for (const one of followedPlaces(writtenPathsByReading(text, where), WRITE_LINK_BUDGET)) {
        found.push(...facts.realOf(one).flatMap((real) => resolvedWriteRefusals(real, cfg, loop, where)));
      }
    } else {
      found = found.filter((one) => one.rule === "secret");
    }
    out.push(...found);
  }
  return out;
}
function resolvedWriteRefusals(real, cfg, loop, where) {
  const out = [];
  const verdict = judgeWrite(real, cfg, loop, where);
  if (verdict !== null) {
    out.push(verdict);
  }
  const tasks = where.tasks === undefined || real.rel === null || real.rel === "" ? null : tasksShellWriteRefusal(real.rel, where.tasks, where);
  if (tasks !== null) {
    out.push(tasks);
  }
  return out;
}
function namesDefaultSecret(tool, input) {
  const where = whereOf("/", "/");
  const text = (key) => typeof input[key] === "string" ? input[key] : "";
  if (SHELL_TOOLS.includes(tool)) {
    return judgeCommandAll(text("command"), DEFAULTS, FRESH, where).some((one) => one.rule === "secret");
  }
  return ["file_path", "notebook_path", "path", "pattern", "glob"].some((key) => text(key) !== "" && isSecretPattern(text(key), "/", where, DEFAULTS));
}
var shippingOf = (text, branch, defaultBranch) => shipsOf(text).filter((one) => one.kind !== "merge" || isOnDefault(one, branch, defaultBranch));
function shipRules(intents, branch, cfg, tier, ranges) {
  if (intents.some((one) => one.kind === "pr-merge")) {
    return { rule: "human-merge", reason: `Merging a pull request is a person's call: the harness cannot see the pull request's own risk. For this change: ${approvers(tier, cfg)}. Leave the merge to them.` };
  }
  if (intents.some((one) => one.kind === "merge")) {
    return { rule: "human-merge", reason: `Merging into ${cfg.defaultBranch} is a person's call. Push your branch and open a pull request instead.` };
  }
  for (const intent of intents) {
    if (intent.kind === "push" && intent.misshapen !== undefined && intent.misshapen !== null) {
      return { rule: "gate", reason: `This push is not of the one shape the harness judges (${intent.misshapen}): the gate judges only the tree checked out, and a push of any other shape can send what it never saw. ${PUSH_ADVICE}${branch !== null && branch !== "(detached)" ? ` Here: \`git push -u origin ${branch}\` or \`git push -u origin HEAD\`.` : ""} Tags, other branches and pushes that configure git are a person's.` };
    }
  }
  for (const intent of intents) {
    const other = pushesOtherBranch(intent, branch);
    if (other !== null) {
      return { rule: "gate", reason: `This push ships ${other}, which is not the branch you are on (${branch ?? "a detached head"}); the gate judged only the tree checked out. Push the branch you are on (\`git push -u origin HEAD\`), or switch to ${other} first and push it by itself.` };
    }
  }
  for (const intent of intents) {
    if (intent.kind !== "push" || !isPushToDefault(intent, branch, cfg.defaultBranch)) {
      continue;
    }
    const files = ranges[pushSource(intent, cfg.defaultBranch)] ?? null;
    if (files === null) {
      return { rule: "human-merge", reason: `This push would land on ${cfg.defaultBranch}, and the harness cannot tell what it would land (origin/${cfg.defaultBranch} is not known here). Pushing to the default branch is a person's call.` };
    }
    const landed = tierWithBlast(files, 0, cfg);
    if (approvalsFor(landed, cfg) > 0) {
      return { rule: "human-merge", reason: `This push would land a ${landed}-risk change on ${cfg.defaultBranch}: ${approvers(landed, cfg)}. Push a branch and open the pull request; a person merges it.` };
    }
  }
  return null;
}
function pushSource(intent, defaultBranch) {
  if (intent.kind !== "push") {
    return "HEAD";
  }
  return intent.sources[intent.targets.indexOf(defaultBranch)] ?? "HEAD";
}
var pushesToDefault = (intents, branch, defaultBranch) => [...new Set(intents.filter((one) => one.kind === "push" && isPushToDefault(one, branch, defaultBranch)).map((one) => pushSource(one, defaultBranch)))];
function differList(seen) {
  const shown = seen.differs.slice(0, 5).map((one) => `${one.path}${one.isUntracked ? " (untracked)" : ""}`);
  const more = Math.max(0, seen.differCount - shown.length);
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}
var COMMIT_OR_STASH = "Commit them (`git add -A`, then `git commit`), stash them with `git stash -u` (a plain `git stash` leaves untracked files behind), or ignore them (`.gitignore`, or `.git/info/exclude` for this clone only), then push again.";
function pushSends(committable, sent, seen = { hidden: [], differs: [], differCount: 0 }) {
  if (seen.hidden.length > 0) {
    const names = `${seen.hidden.slice(0, 5).join(", ")}${seen.hidden.length > 5 ? `, and ${seen.hidden.length - 5} more` : ""}`;
    return { rule: "gate", reason: `Files hidden from git: git is told not to look at changes to ${names} (the skip-worktree or assume-unchanged bit), so neither the gate nor this push can see what they hold. Clear the bit (\`git update-index --no-skip-worktree --no-assume-unchanged <file>\`), then commit or stash what changed, and push again. If the bit is wanted, a person pushes.` };
  }
  if (committable === null || sent.length === 0 || sent.some((one) => one.tree === null)) {
    return { rule: "gate", reason: "The harness could not tell what this push sends against the tree the gate judges, so it is refused. Commit or stash first (git status shows what is not committed), then push again." };
  }
  const other = sent.find((one) => one.tree !== committable);
  if (other === undefined) {
    return null;
  }
  const files = seen.differs.length > 0 ? ` The files that differ from the last commit: ${differList(seen)}.` : "";
  return {
    rule: "gate",
    reason: other.isHead ? `Commit or stash first: the working tree has changes that are not committed, so the gate would judge files this push does not send (the push sends commits, and the last commit is not the tree the gate judges).${files} ${COMMIT_OR_STASH}` : `Commit or stash first: this push sends commits whose tree is not the working tree the gate judged, so it would send work the gate did not judge. Check out what you push and commit it, or stash what is not committed (\`git stash -u\` takes untracked files too), then push again.${files}`
  };
}

// hooks/records.ts
var HARNESS_VERSION = "0.5.0";
var str = (maxLength = 300) => ({ type: "string", maxLength });
var text = (maxLength = 300) => ({ type: "string", maxLength });
var nullableText = (maxLength = 300) => ({ type: ["string", "null"], maxLength });
var int = { type: "integer", minimum: 0 };
var time = { type: "integer", minimum: 0, description: "milliseconds since the epoch" };
var bool = { type: "boolean" };
var strings2 = (maxItems = 500, maxLength = 300) => ({ type: "array", items: str(maxLength), maxItems });
var obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
var INPUTS = obj({
  policy: { type: "string", maxLength: 64, description: "a hash of the devloop.json in force" },
  model: str(120),
  harness: str(40),
  tree: { type: ["string", "null"], maxLength: 80 },
  suite: { type: "object", additionalProperties: { type: "string", maxLength: 64 }, description: "eval task id to the hash of its task file" }
}, ["policy", "model", "harness", "tree"]);
var SEVERITY = { enum: ["critical", "high", "medium", "low", "nit"] };
var TIER = { enum: ["none", "low", "medium", "high"] };
var ROW = obj({ label: str(120), isMet: bool, note: str(600) });
var ACTOR = obj({
  kind: { enum: ["person", "builder", "agent", "harness"] },
  name: nullableText(120)
}, ["kind", "name"]);
var AUDIT_ACTIONS = [
  "spec-approved",
  "spec-reopened",
  "exemption-granted",
  "change-closed",
  "review-verdict",
  "finding-resolved",
  "refusal",
  "policy-error",
  "budget-set",
  "regression-dropped",
  "rule-tombstoned",
  "papercut-closed",
  "defect-recorded",
  "eval-adopted",
  "eval-started",
  "shipped-ungated",
  "record-invalid",
  "handoff-exported",
  "module-skipped",
  "module-absent",
  "git-hook-installed",
  "git-hook-removed",
  "evidence-noted",
  "claim-taken",
  "claim-lapsed",
  "claim-takeover",
  "claim-released",
  "followup-stopped",
  "checklist-promoted",
  "checklist-demoted",
  "checklist-adjudicated",
  "cache-guard-installed",
  "cache-guard-removed",
  "harness-state-changed",
  "answer-unchecked",
  "loop-limit",
  "loop-continued",
  "learned-rule-promoted",
  "learned-rule-dropped",
  "library-saved",
  "library-save-stopped",
  "library-path-set",
  "library-removed",
  "settings-changed"
];
var withTag = (id, title, properties, required = Object.keys(properties)) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `devloop/${id}`,
  title,
  type: "object",
  properties: { schema: { const: id }, ...properties },
  required: ["schema", ...required],
  additionalProperties: false
});
var SCHEMAS = {
  "finding@1": withTag("finding@1", "A review finding as the harness keeps it", {
    id: { type: "string", pattern: "^F\\d+$" },
    reviewer: str(60),
    severity: SEVERITY,
    file: str(400),
    line: int,
    quote: text(600),
    problem: text(1000),
    evidence: text(1000),
    isPreExisting: bool,
    route: { enum: ["fix", "decision", "defer"] },
    status: { enum: ["open", "closed", "resolved", "note", "deferred"] },
    isBlocking: bool,
    round: int,
    seen: int,
    note: nullableText(600)
  }),
  "papercut@1": withTag("papercut@1", "A friction report the agent filed", {
    id: { type: "string", pattern: "^pc\\d+$" },
    at: time,
    group: { type: "string", pattern: "^p-[0-9a-f]{6}$" },
    subject: nullableText(120),
    tried: text(),
    expected: text(),
    happened: text(),
    suggestedFix: text(),
    actor: ACTOR
  }),
  "handoff@1": withTag("handoff@1", "A handoff entry: the builder's narrative (or none) and the harness's facts", {
    at: time,
    by: { enum: ["builder", "person"] },
    file: str(200),
    objective: nullableText(600),
    nextStep: nullableText(600),
    decisions: int,
    deadEnds: int,
    assumptions: int,
    files: strings2(15, 400),
    facts: obj({ phase: { enum: ["idle", "spec", "build"] }, spec: nullableText(60), tree: nullableText(80), changed: int, openFindings: int })
  }),
  "change-record@1": withTag("change-record@1", "A closed change, written at /devloop done", {
    id: { type: "string", pattern: "^C\\d+$" },
    closedAt: time,
    startedAt: time,
    durationMs: int,
    spec: nullableText(60),
    task: nullableText(120),
    tier: TIER,
    tierWhy: strings2(20),
    files: strings2(2000, 400),
    lines: int,
    fixRounds: int,
    reviewRounds: int,
    isFirstPass: { type: ["boolean", "null"] },
    vacuous: strings2(100),
    exemptionsUsed: strings2(100, 400),
    findings: obj({ blocking: int, deferred: int, resolvedByPerson: int }),
    gate: obj({ isGreen: bool, unmet: strings2(40, 600) }),
    costUsd: { type: ["number", "null"], minimum: 0, description: "an estimate" },
    cacheHitRate: { type: ["number", "null"], minimum: 0 },
    attestation: {
      type: ["object", "null"],
      properties: { by: { const: "person" }, at: time, read: { type: "array", items: { enum: ["diff", "tests", "instructions"] }, maxItems: 3 } },
      required: ["by", "at", "read"],
      additionalProperties: false
    },
    inputs: INPUTS
  }, ["id", "closedAt", "startedAt", "durationMs", "spec", "tier", "tierWhy", "files", "lines", "fixRounds", "reviewRounds", "isFirstPass", "vacuous", "exemptionsUsed", "findings", "gate", "costUsd", "cacheHitRate", "attestation", "inputs"]),
  "eval-result@1": withTag("eval-result@1", "One eval task's result in one run (one pass of an ablation)", {
    run: str(40),
    pass: { enum: ["main", "baseline-1", "baseline-2", "without"] },
    kind: { enum: ["full", "quick"] },
    task: str(80),
    taskHash: str(64),
    outcome: { enum: ["pass", "fail", "infra"] },
    trials: { type: "array", maxItems: 10, items: obj({ outcome: { enum: ["pass", "fail", "infra"] }, note: str(300), calls: int, costUsd: { type: ["number", "null"], minimum: 0 } }) },
    successRate: { type: ["number", "null"], minimum: 0 },
    without: nullableText(200),
    at: time,
    inputs: INPUTS
  }),
  "gate@1": withTag("gate@1", "The gate as it was judged at one moment", {
    at: time,
    why: { enum: ["gate-command", "shipping", "shipped", "done"] },
    tier: TIER,
    isGreen: bool,
    rows: { type: "array", items: ROW, maxItems: 60 },
    inputs: INPUTS
  }),
  "evidence@2": withTag("evidence@2", "Portable evidence of a review, as a git note on the reviewed commit (refs/notes/devloop): a record, not a signature", {
    at: time,
    why: { enum: ["review", "done"] },
    tree: { type: "string", maxLength: 80, description: "the committable tree the evidence covers, equal to the commit's tree" },
    full: { type: "string", maxLength: 80, description: "the full tree verified, ignored instruction files included" },
    head: str(80),
    policy: { type: "string", maxLength: 64, description: "a hash of the devloop.json in force" },
    checks: { type: "array", maxItems: 100, items: obj({ run: str(600), tree: str(80) }) },
    reviewers: { type: "array", maxItems: 20, items: obj({ name: str(60), mode: { enum: ["general", "blocking", "shadow"] }, verdict: { enum: ["pass", "fail"] }, round: int }) },
    open: int,
    checklistFails: { ...strings2(60, 120), description: "promoted checklist items that failed on the reviewed tree (list/item): the round is a failing one wherever this note is read" },
    harness: str(40)
  }, ["at", "why", "tree", "head", "policy", "checks", "reviewers", "open", "checklistFails", "harness"]),
  "checklist@1": withTag("checklist@1", "A checklist: checkable statements about a kind of change, kept in checklists/<id>.json on the base branch (D2)", {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,40}$" },
    version: { type: "integer", minimum: 1 },
    title: str(80),
    appliesTo: {
      type: "object",
      properties: { surfaces: strings2(20, 40), paths: strings2(40, 200), detect: str(400) },
      required: [],
      additionalProperties: false
    },
    maxItems: { type: "integer", minimum: 1 },
    items: {
      type: "array",
      maxItems: 60,
      items: obj({
        id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$" },
        statement: { type: "string", minLength: 10, maxLength: 400 },
        why: { type: "string", minLength: 5, maxLength: 300 },
        severity: { enum: ["critical", "high", "medium", "low"] },
        verify: obj({
          by: { enum: ["pattern", "check", "review", "runtime", "person"] },
          how: { type: "string", minLength: 10, maxLength: 600 },
          pattern: str(400),
          expect: { enum: ["present", "absent"] },
          check: str(600)
        }, ["by", "how"]),
        naWhen: strings2(10, 200),
        ref: str(200),
        status: { enum: ["active", "retired"] }
      }, ["id", "statement", "why", "severity", "verify"])
    }
  }),
  "checklist-result@1": withTag("checklist-result@1", "One checklist item's result on one tree: by the harness (pattern, check) or the checklist reviewer (review) (D2)", {
    at: time,
    list: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,40}$" },
    version: { type: "integer", minimum: 1 },
    item: str(41),
    by: { enum: ["pattern", "check", "review", "runtime", "person"] },
    status: { enum: ["pass", "fail", "na", "unverified"] },
    evidence: text(600),
    tree: nullableText(80),
    round: int,
    source: { enum: ["harness", "reviewer"] }
  }),
  "library-entry@1": withTag("library-entry@1", "One spec in the spec library: entry.json in its folder, and (without the criteria) a line of the library's index.jsonl (DESIGN 4.18)", {
    id: { type: "string", pattern: "^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+--\\d{4}-\\d{2}-\\d{2}$", maxLength: 200, description: "the entry's folder: <project>--<spec name>--<yyyy-mm-dd>" },
    project: str(80),
    spec: str(80),
    kind: nullableText(80),
    size: nullableText(20),
    related: strings2(20, 120),
    intent: text(400),
    criteria: { ...strings2(40, 600), description: "the acceptance criteria, text only: in entry.json, never in the index" },
    features: { type: "array", maxItems: 100, items: obj({ id: str(120), description: text(600), check: str(600) }) },
    approvedAt: { type: ["integer", "null"], minimum: 0, description: "milliseconds since the epoch" },
    closedAt: { type: ["integer", "null"], minimum: 0, description: "milliseconds since the epoch; null while the change is open" },
    outcome: obj({
      status: { enum: ["closed", "open"] },
      isAllPassing: { type: ["boolean", "null"], description: "closed with every feature passing; null while open" },
      reviewRounds: int,
      defects: { type: "integer", minimum: 0, description: "escaped defects recorded later against the change" }
    }),
    harness: str(40),
    hash: { type: "string", maxLength: 64, description: "a hash of SPEC.md and features.json as copied" },
    savedAt: time,
    removedAt: { ...time, description: "set on the index line that marks the entry removed" }
  }, ["id", "project", "spec", "kind", "size", "related", "intent", "features", "approvedAt", "closedAt", "outcome", "harness", "hash", "savedAt"]),
  "audit-event@1": withTag("audit-event@1", "One action that changed what may ship", {
    at: time,
    action: { enum: AUDIT_ACTIONS },
    actor: ACTOR,
    subject: text(200),
    tree: nullableText(80),
    detail: text(600)
  })
};
var typeOf = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? Number.isInteger(value) ? "integer" : "number" : typeof value;
function check(schema, value, path = "$") {
  const out = [];
  if (schema.const !== undefined && value !== schema.const) {
    return [`${path}: expected ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return [`${path}: expected one of ${schema.enum.map((one) => JSON.stringify(one)).join(", ")}`];
  }
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      return [`${path}: expected ${types.join(" or ")}, found ${actual}`];
    }
  }
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push(`${path}: longer than ${schema.maxLength} characters`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push(`${path}: shorter than ${schema.minLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      out.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      out.push(`${path}: not a finite number`);
    } else if (schema.minimum !== undefined && value < schema.minimum) {
      out.push(`${path}: below ${schema.minimum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      const items = schema.items;
      value.forEach((one, i) => out.push(...check(items, one, `${path}[${i}]`)));
    }
  }
  if (typeOf(value) === "object") {
    const record = value;
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        out.push(`${path}.${key}: missing`);
      }
    }
    for (const [key, one] of Object.entries(record)) {
      if (one === undefined) {
        continue;
      }
      const known = schema.properties?.[key];
      if (known !== undefined) {
        out.push(...check(known, one, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        out.push(`${path}.${key}: unknown field`);
      } else if (typeof schema.additionalProperties === "object") {
        out.push(...check(schema.additionalProperties, one, `${path}.${key}`));
      }
    }
  }
  return out;
}
var validate = (id, value) => check(SCHEMAS[id], value);

// cli/gate.ts
import process2 from "node:process";

// hooks/inforce.ts
function decidePolicy(working, workingText, baseText) {
  if (baseText === null) {
    return working === null ? null : { cfg: working, source: "working", policy: "no-base" };
  }
  return {
    cfg: parseConfig(baseText).cfg,
    source: "base",
    policy: working === null ? "deleted" : baseText.trim() === (workingText ?? "").trim() ? "same" : "changed"
  };
}

// hooks/grounding.ts
var NUDGE = "This is a question about the state of things: check the source before answering, and say what you checked.";
var REFUSAL = "You were asked a question about the state of things and answered without looking at anything in this turn. Check the source now (read the files, run the query, list the components), then answer and say what you checked. If nothing can be checked (an opinion, a general explanation), say that in one line and stop again.";
var UNCHECKED = "This answer was given without checking anything";
function groundingMode(cfg) {
  return cfg.grounding.mode ?? (cfg.mode === "enforce" ? "observe" : cfg.mode);
}
var OPENERS = ["does", "do", "did", "is", "are", "was", "were", "has", "have", "had", "can", "could", "will", "would", "should", "what", "which", "who", "whose", "where", "when", "why", "how"];
var CHECKING = ["confirm", "verify", "double check", "double-check", "make sure", "are you sure", "is it true", "check whether", "check if", "did you", "have you"];
var GREETING = /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|so|and|also|quick question|good (?:morning|afternoon|evening)|please)\b[\s,.!:;\u2013\u2014-]*)+/i;
var QUESTION_MARK = /\?(?=$|[\s"')\]}*_`>])/;
var matches2 = (pattern, text) => {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
};
function isQuestionOfFact(prompt, also = [], never = []) {
  const text = prompt.trim();
  if (text === "" || text.startsWith("/")) {
    return false;
  }
  if (never.some((pattern) => matches2(pattern, text))) {
    return false;
  }
  if (also.some((pattern) => matches2(pattern, text))) {
    return true;
  }
  if (QUESTION_MARK.test(text)) {
    return true;
  }
  const opening = text.replace(GREETING, "").match(/^[A-Za-z']+/)?.[0]?.toLowerCase() ?? "";
  if (OPENERS.includes(opening)) {
    return true;
  }
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  return CHECKING.some((phrase) => new RegExp(`(?:^|[^a-z])${phrase.replace(/[-]/g, "[- ]?")}(?:$|[^a-z])`).test(lower));
}
function firstLine(prompt) {
  const line = prompt.trim().split(`
`)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
var HEDGES = ["from memory", "as far as i recall", "as far as i remember", "i believe", "i assume", "probably", "should be", "likely", "presumably"];
function hedgeIn(answer) {
  const lower = answer.toLowerCase();
  let best = null;
  for (const phrase of HEDGES) {
    const found = new RegExp(`(?:^|[^a-z])(${phrase})(?:$|[^a-z])`).exec(lower);
    if (found !== null) {
      const at = found.index + found[0].indexOf(found[1] ?? "");
      if (best === null || at < best.at) {
        best = { at, length: phrase.length };
      }
    }
  }
  return best === null ? null : answer.slice(best.at, best.at + best.length);
}
var READERS2 = ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"];
var WORK = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
var AGENTS = ["Agent", "Task"];
var HARNESS_LOOKS = ["mcp__devloop__devloop_status", "mcp__devloop__feature_check"];
var NO_LOOK = ["echo", "printf", "sleep", "true", "false", ":", "cd", "pushd", "popd", "export", "unset", "set", "exit", "wait", "clear", "mkdir", "touch", "rm", "rmdir", "mv", "ln", "chmod", "chown", "tee", "yes", "read"];
function isLook(call) {
  const tool = call.tool;
  if (READERS2.includes(tool) || WORK.includes(tool) || AGENTS.includes(tool) || HARNESS_LOOKS.includes(tool)) {
    return true;
  }
  if (tool.startsWith("mcp__")) {
    return !tool.startsWith("mcp__devloop__");
  }
  if (tool !== "Bash" && tool !== "Monitor" && tool !== "PowerShell") {
    return false;
  }
  const command = typeof call.input.command === "string" ? call.input.command : "";
  return readings(command).every((segments) => segments.some((segment) => {
    const program = segment.program;
    if (program === null || NO_LOOK.includes(program)) {
      return false;
    }
    return !(program === "cat" && segment.reads.length === 0 && segment.writes.length > 0);
  }));
}
function looksIn(calls) {
  return calls.filter(isLook).length;
}
function backstop(facts) {
  if (facts.mode === "off" || !facts.isQuestion || facts.looks > 0 || facts.isTreeChanged || facts.isFreshLook) {
    return { action: "pass" };
  }
  if (facts.mode === "enforce" && !facts.isRefused) {
    return { action: "refuse", reason: REFUSAL };
  }
  const hedge = hedgeIn(facts.answer);
  return { action: "report", toast: `${UNCHECKED}${hedge === null ? "." : `: it says "${hedge}".`}`, hedge };
}
function promptText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const blocks = content.filter((one) => typeof one === "object" && one !== null);
  if (blocks.some((one) => one.type === "tool_result")) {
    return null;
  }
  return blocks.filter((one) => one.type === "text" && typeof one.text === "string").map((one) => one.text).join(`
`);
}
var MACHINE_TEXT = /^\s*<(?:command-name|command-message|local-command|task-notification|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout)/;
function lastTurn(text) {
  const lines = [];
  for (const raw of text.split(`
`)) {
    if (raw.trim() === "") {
      continue;
    }
    try {
      const value = JSON.parse(raw);
      if (typeof value === "object" && value !== null) {
        lines.push(value);
      }
    } catch {}
  }
  let start = -1;
  let prompt = "";
  for (let i = lines.length - 1;i >= 0; i -= 1) {
    const line = lines[i];
    if (line.type !== "user" || line.isMeta === true || line.isSidechain === true || line.toolUseResult !== undefined) {
      continue;
    }
    const said = promptText(line.message?.content);
    if (said !== null) {
      start = i;
      prompt = said;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  const first = lines[start];
  const origin = first.origin;
  const isFromPerson = origin === undefined || origin === null ? first.rowSource === undefined || first.rowSource === null : origin.kind === "human";
  const isPerson = isFromPerson && !MACHINE_TEXT.test(prompt) && !prompt.trim().startsWith("/");
  const calls = [];
  for (const line of lines.slice(start + 1)) {
    if (line.type !== "assistant" || line.isSidechain === true || !Array.isArray(line.message?.content)) {
      continue;
    }
    for (const block of line.message.content) {
      if (typeof block === "object" && block !== null && block.type === "tool_use") {
        const use = block;
        calls.push({ tool: typeof use.name === "string" ? use.name : "", input: typeof use.input === "object" && use.input !== null ? use.input : {} });
      }
    }
  }
  return { isPerson, prompt, calls };
}

// hooks/inject.ts
var BLOCKING_KINDS = ["invisible", "bidi"];
var INVISIBLE = /[​‌‍⁠⁡⁢⁣⁤᠎﻿]|\uDB40[\uDC00-\uDC7F]/;
var BIDI = /[‪-‮⁦-⁩]/;
var DECODE_EXEC = [
  /(?:base64\s+(?:-d|--decode|-D)|b64decode|atob\s*\(|xxd\s+-r|fromCharCode)[^\n]{0,120}?(?:\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\beval\b|\bexec\b|\|\s*(?:python3?|node|perl|ruby)\b)/i,
  /\b(?:eval|exec)\s*\(?[^\n]{0,40}?(?:b64decode|atob\s*\(|base64)/i
];
var PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i;
var NEGATED = /\b(?:never|do not|don't|dont|must not|mustn't|should not|shouldn't|avoid|no)\b/i;
var SECRET_READ = /\b(?:read|cat|print|show|send|upload|post|curl|exfiltrat\w*|copy|paste|include|output|echo)\b[^\n]{0,60}?(?:\.env\b|id_rsa|id_ed25519|\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|private key|api[_ -]?keys?\b|access tokens?\b|\$[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b)/i;
var HARNESS_EDIT = /\b(?:edit|modify|change|update|disable|delete|remove|overwrite|rewrite|write to|append to|turn off)\b[^\n]{0,50}?(?:\.claude\/settings|settings(?:\.local)?\.json|\.claude\/hooks|\.git\/hooks|\.husky|devloop\.json|pre-commit hook|git hooks?)/i;
var ZWNJ_SCRIPTS = "\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}\\p{Script=Khmer}\\p{Script=Myanmar}\\p{Script=Mongolian}";
var INNOCENT_ZWNJ = new RegExp(`([${ZWNJ_SCRIPTS}]\\p{M}*)\\u200C(?=\\p{M}*[${ZWNJ_SCRIPTS}])`, "gu");
var INNOCENT_ZWJ = /(\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)\u200D(?=\p{Extended_Pictographic})/gu;
var withoutInnocentJoiners = (line) => line.replace(INNOCENT_ZWJ, "$1").replace(INNOCENT_ZWNJ, "$1");
var EXAMPLE_FILE = /(?:^|[\s`'"(/])[\w.-]*\.(?:example|sample|template|dist|tmpl)(?:\.[\w]+)?\b|\bexample[\w.-]*\.(?:env|json|ya?ml|toml)\b/i;
function scanInjection(file, text) {
  const out = [];
  const lines = text.split(`
`);
  lines.forEach((raw, i) => {
    const line = i === 0 ? raw.replace(/^\uFEFF/, "") : raw;
    const at = i + 1;
    const shown = line.replace(/[\u200B-\u200D\u2060-\u2064\u180E\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g, "?").trim().slice(0, 100);
    const add = (kind) => {
      out.push({ file, line: at, kind, text: shown });
    };
    if (INVISIBLE.test(withoutInnocentJoiners(line))) {
      add("invisible");
    }
    if (BIDI.test(line)) {
      add("bidi");
    }
    const isNegated = NEGATED.test(line);
    if (!isNegated && DECODE_EXEC.some((one) => one.test(line))) {
      add("decode-exec");
    }
    if (!isNegated && PIPE_TO_SHELL.test(line)) {
      add("pipe-to-shell");
    }
    if (!isNegated && !EXAMPLE_FILE.test(line) && SECRET_READ.test(line)) {
      add("secret-read");
    }
    if (!isNegated && HARNESS_EDIT.test(line)) {
      add("harness-edit");
    }
  });
  return out;
}
var hiddenOf = (file, text) => scanInjection(file, text).filter((one) => BLOCKING_KINDS.includes(one.kind));
var KIND_WORDS = {
  invisible: "invisible or tag characters",
  bidi: "a bidirectional override",
  "decode-exec": "decodes something and runs it",
  "pipe-to-shell": "pipes a download into a shell",
  "secret-read": "tells the reader to read or send a secret",
  "harness-edit": "tells the reader to edit hooks, settings or the policy"
};

// hooks/lint.ts
var isSkillPath = (path) => /(^|\/)skills\//.test(path);
function skillDescription(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front === null) {
    return null;
  }
  const lines = (front[1] ?? "").split(`
`);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) {
    return null;
  }
  let value = (lines[at] ?? "").replace(/^description:\s*/, "");
  for (const more of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(more)) {
      break;
    }
    value += ` ${more.trim()}`;
  }
  return value.replace(/^[>|][-+]?\s*/, "").replace(/^["']|["']$/g, "").trim();
}
var MIME = /^(?:application|text|image|audio|video|multipart|font|model|message)\/[\w.+-]+$/i;
var REF = /^(?:origin|upstream|refs|remotes|heads|tags)\//i;
var PLACEHOLDER = /(?:^|\/)(?:path\/to|foo|bar|baz|qux|example|examples?[-_.]|sample|my[-_]|your[-_]|some[-_]|xxx|placeholder)|^[\w-]+\.(?:test|spec)\.\w+$|^test_[\w-]+\.py$|^[\w-]+_test\.\w+$/i;
function referencedPaths(text) {
  const found = new Set;
  const consider = (raw) => {
    const one = raw.trim().replace(/[#?].*$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
    if (one === "" || /\s/.test(one) || /^[a-z]+:/i.test(one) || /[*?<>{}$|`'"(),;=[\]]/.test(one) || one.startsWith("/") || one.startsWith("~") || one.startsWith("-") || one.startsWith("@") || one.includes("..") || one.length > 200) {
      return;
    }
    const isPathish = /\//.test(one) && /^[\w.@-]+(?:\/[\w.@-]*)+$/.test(one) || /^[\w.-]+\.(?:md|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|rb|java|kt|sh|ya?ml|toml|txt|css|html|sql)$/.test(one);
    if (isPathish && !/^\d+\/\d+$/.test(one) && !/^(?:and|or|either)\/(?:and|or)$/i.test(one) && !MIME.test(one) && !REF.test(one) && !PLACEHOLDER.test(one)) {
      found.add(one.replace(/\/$/, ""));
    }
  };
  const withoutBlocks = text.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutBlocks.matchAll(/`([^`\n]+)`/g)) {
    consider(match[1] ?? "");
  }
  for (const match of withoutBlocks.matchAll(/\]\(([^)\s]+)\)/g)) {
    consider(match[1] ?? "");
  }
  return [...found];
}
function codeAndProse(text) {
  let isFence = false;
  return text.split(`
`).map((line) => {
    if (/^\s*```/.test(line)) {
      isFence = !isFence;
      return { code: "", prose: "" };
    }
    return isFence ? { code: line, prose: "" } : { code: [...line.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "").join(" ; "), prose: line.replace(/`[^`\n]*`/g, " ") };
  });
}
var SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+(?:-{1,2}[\w-]+\s+)*([\w:.-]+)/g;
function namedCommands(text) {
  const out = [];
  let dir = "";
  codeAndProse(text).forEach(({ code, prose }, i) => {
    for (const part of code.split(/\s*(?:&&|;|\|\|)\s*/)) {
      const cd = /^\s*cd\s+([\w./@-]+)\s*$/.exec(part);
      if (cd !== null) {
        const to = (cd[1] ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
        dir = to === "" || to === "." ? "" : to.startsWith("/") || to.includes("..") || to.startsWith("~") || dir === "?" ? "?" : dir === "" ? to : `${dir}/${to}`;
        continue;
      }
      for (const match of part.matchAll(SCRIPT)) {
        out.push({ kind: "script", name: match[1] ?? "", line: i + 1, dir });
      }
      for (const match of part.matchAll(/(?:^|[\s$(])make\s+(?:-[\w]+\s+)*([a-z][\w.-]*)/g)) {
        out.push({ kind: "target", name: match[1] ?? "", line: i + 1, dir });
      }
    }
    for (const match of prose.matchAll(SCRIPT)) {
      out.push({ kind: "script", name: match[1] ?? "", line: i + 1, dir });
    }
  });
  return out.map((one) => ({ ...one, name: one.name.replace(/[.:]+$/, "") })).filter((one) => one.name !== "");
}
var makeTargets = (text) => [...text.matchAll(/^([A-Za-z0-9_.-][A-Za-z0-9_./-]*)\s*:(?!=)/gm)].map((one) => one[1] ?? "").filter((name) => name !== "");
var SHOUT = /\b(?:IMPORTANT|CRITICAL|MUST|NEVER|ALWAYS|MANDATORY|REQUIRED|WARNING|ABSOLUTELY|STRICTLY|DO NOT|DON'T|NOT)\b/;
function shoutedLines(text) {
  const out = [];
  let isCode = false;
  text.split(`
`).forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      isCode = !isCode;
      return;
    }
    const prose = isCode ? "" : line.replace(/`[^`]*`/g, "").replace(/^#+\s.*$/, "");
    if (SHOUT.test(prose) || /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}\b/.test(prose)) {
      out.push(i + 1);
    }
  });
  return out;
}
var RESTATES = /\b(?:indent(?:ation)?\s+(?:with|of|using)\s+(?:\d+\s+spaces|tabs)|use\s+(?:\d+\s+spaces|tabs)\b|(?:use|no|omit)\s+semicolons|(?:use\s+)?(?:single|double)\s+quotes\s+(?:for|in|everywhere)|trailing\s+commas?|(?:max(?:imum)?\s+)?line\s+length\s+(?:of\s+)?\d+|lines?\s+(?:under|below|at most)\s+\d+\s+characters)\b/i;
var restatingLines = (text) => text.split(`
`).flatMap((line, i) => RESTATES.test(line) && line.trim().length < 140 ? [i + 1] : []);
function duplicateBlocks(files) {
  const seen = new Map;
  for (const { path, text } of files) {
    for (const block of text.split(/\n\s*\n/)) {
      const key = block.replace(/\s+/g, " ").trim().toLowerCase();
      if (key.length >= 80) {
        seen.set(key, (seen.get(key) ?? new Set).add(path));
      }
    }
  }
  return [...seen].filter(([, where]) => where.size > 1).map(([key, where]) => ({ files: [...where].sort(), start: key.slice(0, 60) }));
}
var bytesOf = (text) => new TextEncoder().encode(text).length;
var lineList = (lines) => `line${lines.length === 1 ? "" : "s"} ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? ", …" : ""}`;
function lintInstructions(input) {
  const out = [];
  const launch = input.files.filter((one) => !isSkillPath(one.path));
  const skills = input.files.filter((one) => /(^|\/)SKILL\.md$/.test(one.path));
  const described = skills.map((one) => skillDescription(one.text) ?? "").join(`
`);
  const total = launch.reduce((sum, one) => sum + bytesOf(one.text), 0) + bytesOf(described);
  out.push({
    level: total > input.maxBytes ? "error" : "ok",
    text: `launch-loaded instruction text: ${(total / 1024).toFixed(1)} KiB across ${launch.length} file${launch.length === 1 ? "" : "s"}${skills.length > 0 ? ` and ${skills.length} skill description${skills.length === 1 ? "" : "s"}` : ""} (budget ${(input.maxBytes / 1024).toFixed(0)} KiB, "instructionMaxBytes"): every task pays for it`
  });
  for (const { path, text } of launch) {
    const lines = text.split(`
`).length;
    if (lines > input.maxLines) {
      out.push({ level: "warn", text: `${path}: ${lines} lines, over the ${input.maxLines} "instructionMaxLines" allows` });
    }
    const shouted = shoutedLines(text);
    if (shouted.length > 0) {
      out.push({ level: "warn", text: `${path}: ALL-CAPS emphasis on ${lineList(shouted)}: emphasis compensates for a model; state the fact once` });
    }
    const missing = referencedPaths(text).filter((ref) => !input.existing.has(ref));
    if (missing.length > 0) {
      out.push({ level: "warn", text: `${path}: refers to paths that do not exist: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}` });
    }
    const scriptsOf = (dir) => dir === "" ? input.scripts : input.scriptsIn?.[dir] ?? null;
    const gone = namedCommands(text).filter((one) => one.kind === "script" ? scriptsOf(one.dir) !== null && !(scriptsOf(one.dir) ?? []).includes(one.name) : input.targets !== null && one.dir === "" && !input.targets.includes(one.name));
    if (gone.length > 0) {
      out.push({
        level: "warn",
        text: `${path}: names commands that do not exist: ${gone.slice(0, 5).map((one) => `${one.kind === "script" ? `package script${one.dir === "" ? "" : ` (in ${one.dir})`}` : "make target"} "${one.name}" (line ${one.line})`).join(", ")}`
      });
    }
    const restated = input.hasFormatter ? restatingLines(text) : [];
    if (restated.length > 0) {
      out.push({ level: "warn", text: `${path}: ${lineList(restated)} only restate${restated.length === 1 ? "s" : ""} what the formatter or linter config enforces` });
    }
  }
  for (const one of duplicateBlocks(launch)) {
    out.push({ level: "warn", text: `the same block is in ${one.files.join(" and ")} ("${one.start}…"): keep it in one place` });
  }
  return out;
}
function stepsOf(body) {
  const lines = body.split(`
`);
  const steps = [];
  let current = null;
  let isCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      isCode = !isCode;
    }
    if (!isCode && /^\s*\d+[.)]\s+\S/.test(line)) {
      if (current !== null) {
        steps.push(current.join(`
`));
      }
      current = [line];
    } else if (current !== null) {
      if (!isCode && /^#{1,6}\s/.test(line)) {
        steps.push(current.join(`
`));
        current = null;
      } else {
        current.push(line);
      }
    }
  }
  if (current !== null) {
    steps.push(current.join(`
`));
  }
  return steps;
}
function lintSkill(text, hasMcp) {
  const description = skillDescription(text);
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = body.split(`
`).length;
  const steps = stepsOf(body);
  const withCommand = steps.filter((step) => /`[^`]+`|```/.test(step));
  const withCheck = steps.filter((step) => /\b(?:verify|check|confirm|expect|should (?:see|print|show|return|pass)|until|succeeds?|exits? 0|passes)\b/i.test(step));
  const recovery = /^#{1,6}\s+.*(?:error|recover|troubleshoot|failure|when .* fails|if .* fails)/im.exec(body);
  const recoveryText = recovery === null ? "" : body.slice(recovery.index).split(/\n#{1,6}\s/)[0] ?? "";
  const rows = recoveryText.split(`
`).filter((line) => /^\s*\|/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line));
  const isOnlyRetry = rows.length > 1 && rows.slice(1).every((row) => /try again|retry|re-run|rerun/i.test(row) && row.split("|").filter((cell) => cell.trim() !== "").length <= 2);
  const shellBlocks = (body.match(/```(?:bash|sh|shell|console)?\n/g) ?? []).length;
  return [
    {
      name: "description",
      isPassing: description !== null && description.length <= 400 && /\b(?:use (?:this|it|when|for)|when\b|trigger|invoke)/i.test(description),
      note: description === null ? "no description in the front matter" : description.length > 400 ? `the description is about ${Math.round(description.length / 4)} tokens; keep it near 100, since it is loaded always` : /\b(?:use (?:this|it|when|for)|when\b|trigger|invoke)/i.test(description) ? "says when to use it, short enough to load always" : "does not say when to use the skill"
    },
    { name: "length", isPassing: lines < 500, note: `${lines} lines${lines < 500 ? "" : ": move bulky material to referenced files"}` },
    { name: "numbered steps", isPassing: steps.length > 0, note: steps.length > 0 ? `${steps.length} numbered step${steps.length === 1 ? "" : "s"}` : "no numbered steps" },
    {
      name: "commands and checks",
      isPassing: steps.length > 0 && withCommand.length * 2 >= steps.length && withCheck.length > 0,
      note: steps.length === 0 ? "no steps to judge" : `${withCommand.length} of ${steps.length} steps give a command; ${withCheck.length} say what result to check`
    },
    {
      name: "error recovery",
      isPassing: recovery !== null && rows.length >= 2 && !isOnlyRetry,
      note: recovery === null ? "no error-recovery section" : rows.length < 2 ? "the error-recovery section has no table of failures and fixes" : isOnlyRetry ? '"try again" is not a fix' : "a table of failures and their fixes"
    },
    {
      name: "scripts over prose",
      isPassing: shellBlocks < 6,
      isAdvice: true,
      note: shellBlocks < 6 ? "fine" : `${shellBlocks} shell blocks: steps that never vary belong in a script the skill runs (advice)`
    },
    { name: "no tool servers", isPassing: !hasMcp, note: hasMcp ? "the skill folder ships a .mcp.json: a skill must not install tool servers" : "ships no .mcp.json" }
  ];
}
function isHardFailure(one, text) {
  if (one.name === "description") {
    const description = skillDescription(text);
    return description === null || description.length > 400;
  }
  return one.name === "length" || one.name === "no tool servers";
}
function lintSkills(skills) {
  return skills.map(({ path, text, hasMcp }) => {
    const checks = lintSkill(text, hasMcp);
    const failed = checks.filter((one) => !one.isPassing && one.isAdvice !== true);
    const advice = checks.filter((one) => !one.isPassing && one.isAdvice === true);
    const hard = failed.filter((one) => isHardFailure(one, text));
    return {
      level: hard.length > 0 ? "error" : failed.length + advice.length > 0 ? "warn" : "ok",
      text: `skill ${path}: ${checks.map((one) => `${one.name} ${one.isPassing ? "pass" : one.isAdvice === true ? "advice" : "FAIL"}`).join(", ")}${[...failed, ...advice].length > 0 ? ` (${[...failed, ...advice].map((one) => `${one.name}: ${one.note}`).join("; ")})` : ""}`
    };
  });
}
function lintInjection(files) {
  return files.flatMap(({ path, text }) => scanInjection(path, text).map((one) => ({
    level: BLOCKING_KINDS.includes(one.kind) ? "error" : "warn",
    text: `${one.file}:${one.line}: ${KIND_WORDS[one.kind]}${BLOCKING_KINDS.includes(one.kind) ? " (keeps the gate shut while changed)" : ""}: ${one.text}`
  })));
}

// hooks/portable.ts
var policyHash = (cfg) => digest(JSON.stringify(cfg));
var NOTE_READ = `
# devloop:note-read
ref=$1
[ -n "$ref" ] || ref=HEAD
git notes --ref=devloop show "$ref" 2>/dev/null || exit 3
`;
function parseEvidence(text) {
  if (text === null || text.trim() === "") {
    return null;
  }
  try {
    const value = JSON.parse(text.trim());
    return validate("evidence@2", value).length === 0 ? value : null;
  } catch {
    return null;
  }
}
function isOlderEvidence(text) {
  if (text === null || text.trim() === "") {
    return false;
  }
  try {
    const value = JSON.parse(text.trim());
    return typeof value === "object" && value !== null && typeof value.schema === "string" && /^evidence@\d+$/.test(value.schema) && value.schema !== "evidence@2";
  } catch {
    return false;
  }
}
var OLDER_NOTE = "the note was written by an older version of the harness; run the review again";
function reviewRowFrom(label, name, note, tree, policy, isOlder = false) {
  if (note === null && isOlder) {
    return { label, isMet: false, note: OLDER_NOTE };
  }
  if (note === null) {
    return { label, isMet: false, note: "no evidence of a review for this tree: the harness writes a git note (refs/notes/devloop) on the reviewed commit; fetch it with git fetch origin refs/notes/devloop:refs/notes/devloop" };
  }
  if (tree === null || note.tree !== tree) {
    return { label, isMet: false, note: `the evidence names tree ${note.tree.slice(0, 8)}, but the tree is now ${(tree ?? "none").slice(0, 8)}` };
  }
  if (note.policy !== policy) {
    return { label, isMet: false, note: "the evidence for this tree was produced under another policy (its devloop.json hash differs from the one in force), so it does not count" };
  }
  const one = note.reviewers.find((each) => each.name === name);
  if (one === undefined) {
    return { label, isMet: false, note: `the evidence for this tree names no ${name === "general" ? "independent" : name} review` };
  }
  if (one.mode === "shadow") {
    return { label, isMet: false, note: `the evidence names ${name} only as a shadow reviewer: this row needs its own passing outcome in a general or blocking mode` };
  }
  if (one.verdict !== "pass" || note.open > 0) {
    return { label, isMet: false, note: `round ${one.round} did not pass${note.open > 0 ? ` (${note.open} blocking finding${note.open === 1 ? "" : "s"} open)` : ""}` };
  }
  if (name === "general" && note.checklistFails.length > 0) {
    return { label, isMet: false, note: `a failing verdict: round ${one.round} left promoted checklist items failing on the tree it read: ${note.checklistFails.slice(0, 5).join(", ")}${note.checklistFails.length > 5 ? ", …" : ""}` };
  }
  return { label, isMet: true, note: `passed in round ${one.round} (a git note on ${note.head.slice(0, 8)}: a record, not a signature)` };
}
function proofLoop(proof, cfg) {
  const base = statelessLoop("idle");
  const failed = proof.runs.find((one) => !one.isPassing) ?? null;
  const passedOn = Object.fromEntries(proof.runs.filter((one) => one.isPassing && proof.tree !== null).map((one) => [one.run, proof.tree]));
  const infra = failed !== null && failed.outcome !== "fail" ? failed.outcome : null;
  return {
    ...base,
    tree: proof.tree,
    isBaseKnown: proof.base !== null,
    changed: proof.files,
    hasTouchedTests: proof.files.some((file) => matchesAny(file, cfg.tests)),
    size: { files: proof.files.length, lines: proof.lines },
    tier: tierWithBlast(proof.files, proof.lines, cfg),
    isDirty: false,
    verify: {
      ...base.verify,
      status: failed !== null ? "fail" : proof.runs.length > 0 ? "pass" : "none",
      failed: failed?.run ?? null,
      infra,
      tree: proof.tree,
      profile: "full",
      passedOn
    },
    evidence: { tree: proof.isScanned ? proof.tree : null, credentials: proof.credentials, testsChanged: [], testsAdded: [], hidden: proof.hidden }
  };
}
var reviewerOf = (label) => label === "Independent review" ? "general" : label.startsWith("Review: ") ? label.slice("Review: ".length) : null;
function statelessGate(proof, cfg, facts) {
  const loop = proofLoop(proof, cfg);
  const rows = gate(loop, cfg, { ...facts, isStateless: true }).map((row) => {
    const name = reviewerOf(row.label);
    return name === null ? row : reviewRowFrom(row.label, name, proof.note, proof.committable, policyHash(cfg), proof.isOlderNote === true);
  });
  const skipped = backgroundFor(cfg.verify, loop.changed).map((one) => one.run);
  if (skipped.length > 0) {
    rows.push({ label: "Background checks", isMet: true, note: `${NOT_CHECKED_HERE}: ${skipped.join(", ")}` });
  }
  return { loop, rows, isGreen: rows.every((row) => row.isMet) };
}
var checksFor = (cfg, files, isEmpty) => isEmpty ? [] : stepsFor(cfg.verify, "full", files).map((one) => one.run);
var NOT_CHECKED_HERE = "not checked here (background): CI or the session's background run proves it";

// hooks/residual.ts
var RESIDUAL_RISKS = [
  { id: "R1", line: "A script or build tool writes what it likes" },
  { id: "R2", line: "A path held in a variable the line does not set to a literal (narrowed in the cache-guard round)" },
  { id: "R3", line: "Where the shell is, beyond the one folder each reading of the model follows: a `cd` that fails, a move in a pipeline stage, subshell or after `&&`/`||`, the shell's own stack, a physical move through a link the line makes, `CDPATH`, `cdable_vars`, a `trap` body, a function or loop body, a computed target, `pushd -n`, `cd` with no word, an assigned `PWD` or `OLDPWD`, `~N`, a per-command folder option, `/proc/self/cwd`, the file `xargs -a` reads (the twelfth round, W5) or the one fed to `xargs` (the fourteenth round, CC4); the previous folder (`$OLDPWD`, `~-`, `cd -`), a link copied, moved or made on the line, `eval` of literal words, `env cd`, a function named `cd`, `extglob` and `dotglob` patterns, a wildcard move past the listing cap, a read in a function body run elsewhere (Y3); a wildcard through a link in a folder past the listing cap (CC4); a stack form after two `pushd`s, a `pushd` into a folder the line makes, a wildcard beside a `..` after a link, a wildcard `cd` target bash refuses (the thirteenth round, BB7: what both readings miss); a `~+` inside an assignment, a read with a wildcard in the first part under `/`, a path with white space attached to an option or made on the same line (EE3)" },
  { id: "R4", line: "Code on an interpreter's stdin or in a heredoc" },
  { id: "R5", line: "History operations rewrite the tree without naming a path" },
  { id: "R6", line: "Archives and package managers write unnamed files" },
  { id: "R7", line: "An untracked locked file under a folder a command writes, or matched by a `find` filter" },
  { id: "R8", line: "A recursive read of a folder reads the secrets in it (narrowed in the cache-guard round)" },
  { id: "R9", line: "A package manager reaches its registry without a host in the command" },
  { id: "R10", line: "Only secrets fold case" },
  { id: "R11", line: "A URL passed to a text tool, then onward" },
  { id: "R12", line: "A writer fed through `xargs` by a lister the model does not know, or by any lister in small-fix mode" },
  { id: "R13", line: "A computed program that is named like a test run" },
  { id: "R14", line: "Test weakening the marker counts do not see" },
  { id: "R15", line: "A test file hollowed or deleted by a shell command that is not a plain delete or rename" },
  { id: "R16", line: "A credential the short scan does not know" },
  { id: "R17", line: "A finding whose quote is real but whose problem is not" },
  { id: "R18", line: "A skip or focus marker reached after a dot" },
  { id: "R19", line: "A test file git does not track, deleted by a shell command" },
  { id: "R20", line: "A credential the generic assignment shape leaves out on purpose" },
  { id: "R21", line: "A real provider token whose characters spell an obvious placeholder" },
  { id: "R22", line: "A runner override other than a Go `TestMain` that never calls `m.Run()`" },
  { id: "R23", line: "A reviewer's doubt written as prose beside a readable verdict" },
  { id: "R24", line: "A feature check judged by its text" },
  { id: "R25", line: "Injected instructions the scan of instruction and skill files does not see (C1)" },
  { id: "R26", line: "What a scrubbed check environment still lets a check reach (C1)" },
  { id: "R27", line: "A program that ships without a shipping command in the line (C2, L2)" },
  { id: "R28", line: "What content rules do not read (C2)" },
  { id: "R29", line: "An ablation's verdict is only as good as its sample (C2)" },
  { id: "R30", line: "A trajectory is the eval agent's own tool calls as the harness saw them (C2)" },
  { id: "R31", line: "A ship that got past the gate is detected, not prevented (C2, L2 9b)" },
  { id: "R32", line: "A git alias defined in git's config, not on the line (C2.1)" },
  { id: "R33", line: "Two calls sent together are counted by what their text says they write (C2.1)" },
  { id: "R34", line: "An eval agent reads outside its sandbox (C2.1)" },
  { id: "R35", line: "What reaches the evidence notes with no mention of the ref on the line (D2; narrowed in the final round)" },
  { id: "R36", line: "`.tasks` state written by something other than the agent's own `tasks` command or edit tool (D2; narrowed in the final round)" },
  { id: "A1", line: "Hard links and case aliases" },
  { id: "A2", line: "A tool the plugin does not judge" },
  { id: "A3", line: "The base is found by a branch name before the base's policy is read" },
  { id: "A4", line: "The approval run of the feature checks" },
  { id: "A5", line: "Cache-miss causes are inferred" },
  { id: "A6", line: "A command exemption covers no test file" },
  { id: "A7", line: "Handoff entries are not part of the change" },
  { id: "A8", line: "Ignored instruction files in dependency and build folders, or past the sweep's first 500" },
  { id: "A9", line: "The instruction lints are heuristics, so they never fail" },
  { id: "A10", line: "Opt-in is read from the working tree and the base the harness finds" },
  { id: "A11", line: "What the stateless core cannot enforce (D1)" },
  { id: "A12", line: "A git note is not a signature (D1)" },
  { id: "A13", line: "An agent that can delete or edit the plugin removes every enforcement point (D1)" },
  { id: "A14", line: "Skip detection rests on the engine's ids (D1)" },
  { id: "A15", line: "The command line is stateless (D1)" },
  { id: "A16", line: "A check that reads a file under `.tasks/` (D2)" },
  { id: "A17", line: "Claims are cooperative and local (D2)" },
  { id: "A18", line: "Follow-ups read what people write on a pull request (D2)" },
  { id: "A19", line: "Without node on the PATH there is no fallback (final round)" },
  { id: "A20", line: "Two sessions in one working directory are one seat (final round)" },
  { id: "A21", line: "The cache-guard installer edits user-level settings on the person's say-so (4.14)" },
  { id: "A22", line: "cache-guard's own hooks are outside devloop's enforcement (4.14)" },
  { id: "A23", line: "Prices in cache-guard go stale (4.14)" },
  { id: "A24", line: "What the classic hook still keeps on disk and trusts: stamps, heartbeat, stop record, inbox, prompt stamps (P-D)" },
  { id: "A25", line: "Grounding does not judge whether the look was the right one (4.15)" },
  { id: "A26", line: "Grounding does not see a question the agent asks itself (4.15)" },
  { id: "A27", line: "The classic Stop hook skips grounding when the transcript cannot be read (4.15)" },
  { id: "A28", line: "A check scoped too narrowly by its `when` globs is skipped for changes it should cover (4.16)" },
  { id: "A29", line: "A trial rule's hits count matches, not mistakes (4.17)" },
  { id: "A30", line: "The proposer is a model reading failure samples (4.17)" },
  { id: "A31", line: "A spec can describe confidential work in words the credential scan does not catch (4.18)" },
  { id: "A32", line: "The library does not judge fit, nor merge a folder two people wrote at once (4.18)" }
];

// hooks/sandbox.ts
function sandboxSettings(cfg, stateRoot) {
  const unique = (items) => [...new Set(items.filter((one) => one.trim() !== ""))];
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      ...cfg.network === null ? {} : { network: { allowedDomains: unique(cfg.network.allow) } },
      filesystem: {
        denyRead: unique(cfg.secrets),
        denyWrite: unique([...cfg.protected, ...BUILTIN_PROTECTED, stateRoot])
      }
    }
  };
}
var isObject2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var strings3 = (value) => Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];
function sandboxOf2(files) {
  const merged = {};
  const errors = [];
  const network = {};
  const filesystem = {};
  for (const file of files) {
    if (file.text === null) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      errors.push(`${file.name} is not JSON`);
      continue;
    }
    const box = isObject2(parsed) && isObject2(parsed.sandbox) ? parsed.sandbox : null;
    if (box === null) {
      continue;
    }
    for (const [key, value] of Object.entries(box)) {
      if (key === "network" && isObject2(value)) {
        for (const [k, v] of Object.entries(value)) {
          network[k] = Array.isArray(v) ? [...strings3(network[k]), ...strings3(v)] : v;
        }
      } else if (key === "filesystem" && isObject2(value)) {
        for (const [k, v] of Object.entries(value)) {
          filesystem[k] = Array.isArray(v) ? [...strings3(filesystem[k]), ...strings3(v)] : v;
        }
      } else {
        merged[key] = Array.isArray(value) ? [...strings3(merged[key]), ...strings3(value)] : value;
      }
    }
  }
  return { found: { ...merged, network, filesystem }, errors };
}
var SHARED_HOSTING = ["amazonaws.com", "cloudfront.net", "githubusercontent.com", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "azurewebsites.net", "appspot.com", "blob.core.windows.net", "storage.googleapis.com", "ngrok.io", "ngrok-free.app"];
function isBroadDomain(domain) {
  const bare = domain.trim().toLowerCase();
  if (bare === "*" || bare === "*.*" || bare === "") {
    return true;
  }
  if (bare.startsWith("*.")) {
    const rest = bare.slice(2);
    return !rest.includes(".") || SHARED_HOSTING.some((one) => rest === one || rest.endsWith(`.${one}`));
  }
  return false;
}
var RC_FILES = [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".envrc", ".gitconfig"];
function writableRisk(path, home, pathDirs) {
  const expanded = home !== null && (path === "~" || path.startsWith("~/")) ? `${home}${path.slice(1)}` : path;
  const clean = expanded.replace(/\/+$/, "") || "/";
  if (clean === "~" || clean === home || clean === "/") {
    return `${path} (a whole home or root folder: its shell start-up files and any bin folder)`;
  }
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  if (RC_FILES.includes(name)) {
    return `${path} (a shell start-up file)`;
  }
  const dir = pathDirs.find((one) => one !== "" && (clean === one.replace(/\/+$/, "") || one.startsWith(`${clean}/`)));
  if (dir !== undefined) {
    return `${path} (${dir} is on $PATH)`;
  }
  return null;
}
function compareSandbox(found, cfg, stateRoot, env) {
  const out = [];
  const want = sandboxSettings(cfg, stateRoot).sandbox;
  if (found.enabled !== true) {
    out.push({ level: "warn", text: 'sandbox: not enabled in .claude/settings.json or .claude/settings.local.json ("sandbox": { "enabled": true }); this plugin is a tripwire, the sandbox is the boundary. /devloop sandbox prints the block that matches the policy' });
  } else {
    out.push({ level: "ok", text: "sandbox: enabled in the project settings" });
  }
  const network = isObject2(found.network) ? found.network : {};
  const filesystem = isObject2(found.filesystem) ? found.filesystem : {};
  const domains = strings3(network.allowedDomains);
  if (want.network !== undefined) {
    const missing = want.network.allowedDomains.filter((one) => !domains.includes(one));
    const extra = domains.filter((one) => !want.network?.allowedDomains.includes(one));
    if (missing.length > 0) {
      out.push({ level: "warn", text: `sandbox: network.allow names hosts the sandbox does not allow: ${missing.join(", ")}` });
    }
    if (extra.length > 0) {
      out.push({ level: "warn", text: `sandbox: allows hosts devloop.json's network.allow does not name: ${extra.join(", ")} (commands that reach them are refused by the tripwire; the sandbox lets other programs reach them)` });
    }
  } else if (found.enabled === true && domains.length > 0) {
    out.push({ level: "ok", text: `sandbox: allows ${domains.length} host${domains.length === 1 ? "" : "s"}; devloop.json sets no network.allow, so the egress tripwire is off` });
  }
  const denyRead = strings3(filesystem.denyRead);
  const unread = want.filesystem.denyRead.filter((one) => !denyRead.includes(one));
  if (found.enabled === true && unread.length > 0) {
    out.push({ level: "warn", text: `sandbox: the policy's secrets are not denied reads: ${unread.slice(0, 8).join(", ")}${unread.length > 8 ? ", …" : ""}` });
  }
  const denyWrite = strings3(filesystem.denyWrite);
  const unwritten = want.filesystem.denyWrite.filter((one) => !denyWrite.includes(one));
  if (found.enabled === true && unwritten.length > 0) {
    out.push({ level: "warn", text: `sandbox: protected paths are not denied writes: ${unwritten.slice(0, 8).join(", ")}${unwritten.length > 8 ? ", …" : ""}` });
  }
  for (const domain of domains.filter(isBroadDomain)) {
    out.push({ level: "warn", text: `sandbox: the allowed domain ${domain} is broad enough to defeat the allow-list (anyone can publish under it)` });
  }
  const sockets = strings3(network.allowUnixSockets);
  if (network.allowAllUnixSockets === true) {
    out.push({ level: "warn", text: "sandbox: network.allowAllUnixSockets is on: a container socket among them hands out the machine" });
  }
  for (const one of sockets.filter((each) => /docker\.sock|podman\.sock|containerd\.sock|\/run\/docker/.test(each))) {
    out.push({ level: "warn", text: `sandbox: a container socket is reachable (${one}): whoever reaches it can start a container that mounts the host` });
  }
  for (const one of strings3(filesystem.allowWrite)) {
    const risk = writableRisk(one, env.home, env.pathDirs);
    if (risk !== null) {
      out.push({ level: "warn", text: `sandbox: writes are allowed to ${risk}` });
    }
  }
  const weakened = [
    [found.allowUnsandboxedCommands !== false && found.enabled === true, "allowUnsandboxedCommands is not false: a command that fails in the sandbox may be retried outside it"],
    [strings3(found.excludedCommands).length > 0, `excludedCommands run outside the sandbox: ${strings3(found.excludedCommands).slice(0, 5).join(", ")}`],
    [found.enableWeakerNestedSandbox === true, "enableWeakerNestedSandbox is on (it exposes process information)"],
    [found.enableWeakerNetworkIsolation === true, "enableWeakerNetworkIsolation is on"],
    [found.allowNestedUserNamespaces === true, "allowNestedUserNamespaces is on (it turns off a security boundary)"],
    [network.allowLocalBinding === true, "network.allowLocalBinding is on"],
    [filesystem.disabled === true, "filesystem.disabled is on: only the network is isolated"]
  ];
  for (const [isSet, text] of weakened) {
    if (isSet) {
      out.push({ level: "warn", text: `sandbox: ${text}` });
    }
  }
  return out;
}

// hooks/scan.ts
function addedLines2(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let isHeader = false;
  for (const text of diff.split(`
`)) {
    if (text.startsWith("diff --git ")) {
      isHeader = true;
      file = null;
      continue;
    }
    if (isHeader && text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^"(.*)"$/, "$1");
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk !== null) {
      isHeader = false;
      line = Number(hunk[1]);
      continue;
    }
    if (isHeader || file === null) {
      continue;
    }
    if (text.startsWith("+")) {
      out.push({ file, line, text: text.slice(1) });
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return out;
}
var PLACEHOLDER2 = /x{4,}|example|placeholder|dummy|changeme|change_me|your[_-]?|sample|fake|redacted|<[^>]*>|\$\{|\{\{|\*{4,}|0{8,}|12345678|abcdefgh/i;
var OBVIOUS = /example|placeholder|your|x{4}/i;
var isRepeated = (text) => text.length > 0 && new Set(text).size === 1;
function entropy(text) {
  const counts = new Map;
  for (const c of text) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, n) => {
    const p = n / text.length;
    return sum - p * Math.log2(p);
  }, 0);
}
var KEY = "[A-Za-z0-9_.-]*?(?:api[_-]?key|secret(?:[_-]?key)?|token|passwd|password|access[_-]?key|private[_-]?key)";
var SHAPES = [
  { kind: "AWS access key id", pattern: /\b((?:AKIA|ASIA)([0-9A-Z]{16}))\b/g, exact: () => true },
  { kind: "GitHub token", pattern: /\b(gh[pousr]_([A-Za-z0-9]{36,})|github_pat_([A-Za-z0-9_]{22,}))\b/g, exact: (value) => /^gh[pousr]_[A-Za-z0-9]{36}$/.test(value) || /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/.test(value) },
  { kind: "Slack token", pattern: /\b(xox[abposr]-([0-9A-Za-z-]{10,}))\b/g },
  { kind: "private key", pattern: /^\s*(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)\s*$/g },
  {
    kind: "API key or secret assignment",
    pattern: new RegExp(`(?:\\b${KEY}["']?\\s*[:=]\\s*["']([^"'\\s]{20,})["']|^\\s*(?:export\\s+)?${KEY}\\s*[:=]\\s*([^\\s"'#]{20,})\\s*(?:#.*)?$)`, "gi"),
    isGeneric: true
  }
];
var ENTROPY_FLOOR = 3.5;
function isNotSecretValue(value) {
  return /:\/\//.test(value) || /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(value) || /^\^|\$$|\\[dDwWsSbB]|\[[^\]]*-[^\]]*\]|\(\?|\.\*|\.\+|\{\d+,\d*\}/.test(value) || /^[A-Z][A-Z0-9_]*$/.test(value) || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value);
}
function credentialKinds(text) {
  const out = [];
  for (const { kind, pattern, exact, isGeneric } of SHAPES) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? "";
      const body = match.slice(2).find((one) => one !== undefined) ?? value;
      let isFiller;
      if (kind === "private key") {
        isFiller = false;
      } else if (exact?.(value) === true) {
        isFiller = OBVIOUS.test(body) || isRepeated(body);
      } else {
        isFiller = PLACEHOLDER2.test(value);
      }
      const isCounted = isGeneric !== true || entropy(value) >= ENTROPY_FLOOR && !isNotSecretValue(value);
      if (!isFiller && isCounted && !out.includes(kind)) {
        out.push(kind);
      }
    }
  }
  return out;
}
function scanCredentials(lines, cap = 20) {
  const out = [];
  for (const one of lines) {
    for (const kind of credentialKinds(one.text)) {
      out.push({ file: one.file, line: one.line, kind });
    }
    if (out.length >= cap) {
      break;
    }
  }
  return out.slice(0, cap);
}

// hooks/scripts.ts
var SNAPSHOT = `
# devloop:snapshot
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
current=$(git symbolic-ref --short -q HEAD 2>/dev/null)
base=""
if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  remoteHead=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  for ref in "origin/$1" "$1" "$remoteHead" origin/main main origin/master master; do
    [ -n "$ref" ] && [ "$ref" != "$current" ] || continue
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$ref" 2>/dev/null)
      break
    fi
  done
else
  base=$(git hash-object -t tree /dev/null)
fi
if [ -n "$2" ] && git merge-base --is-ancestor "$2" HEAD 2>/dev/null; then
  if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$2" 2>/dev/null; then base=$2; fi
fi
if [ "$#" -ge 2 ]; then shift 2; else set --; fi
dir=$(mktemp -d)
idx="$dir/index"
# -p keeps the index's own timestamps. A copy newer than a file edited in the
# same second makes git trust the cached size and time, and miss the edit.
cp -p "$(git rev-parse --git-path index)" "$idx" 2>/dev/null
plain=""
tree=""
if GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1; then
  plain=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
  if [ "$#" -gt 0 ]; then
    git -c core.quotePath=false ls-files -o -i --exclude-standard -- "$@" 2>/dev/null | awk -F/ '{ print NF "	" $0 }' | sort -s -n -k1,1 | cut -f2- >"$dir/swept"
    count=$(wc -l <"$dir/swept" | tr -d ' ')
    head -500 "$dir/swept" >"$dir/ignored"
    [ "$count" -gt 500 ] && echo "capped:$count" >>"$dir/listed"
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      GIT_INDEX_FILE="$idx" git add -f -- "$f" >/dev/null 2>&1 && echo "ignored:$(git hash-object -- "$f") $f" >>"$dir/listed"
    done <"$dir/ignored"
  fi
  tree=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
fi
echo "tree:$tree"
echo "committable:$plain"
echo "headtree:$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null)"
echo "branch:$current"
echo "head:$(git rev-parse -q --verify HEAD 2>/dev/null)"
if [ -n "$base" ]; then echo "base:$base"; else echo "base:unknown"; fi
[ -f "$dir/listed" ] && cat "$dir/listed"
git -c core.quotePath=false ls-files -s -v 2>/dev/null | grep -E '^(S|[a-z]) ' >"$dir/bits"
fileMode=$(git config --bool core.fileMode 2>/dev/null)
n=0
while IFS=$'	' read -r meta f; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  n=$((n + 1))
  if [ "$n" -gt 100 ]; then echo "hiddencap:100"; break; fi
  read -r tag mode blob stage <<<"$meta"
  if [ -L "$f" ]; then now=$(printf '%s' "$(readlink -- "$f")" | git hash-object --stdin 2>/dev/null); else now=$(git hash-object -- "$f" 2>/dev/null); fi
  if [ "$now" != "$blob" ]; then
    echo "hidden:$f"
  elif [ "$fileMode" != false ] && [ ! -L "$f" ] && { { [ "$mode" = 100755 ] && [ ! -x "$f" ]; } || { [ "$mode" = 100644 ] && [ -x "$f" ]; }; }; then
    echo "hidden:$f"
  fi
done <"$dir/bits"
headTree=$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null)
if [ -n "$plain" ] && [ -n "$headTree" ] && [ "$plain" != "$headTree" ]; then
  git -c core.quotePath=false diff --no-renames --name-only HEAD "$plain" 2>/dev/null >"$dir/differs"
  echo "differcount:$(wc -l <"$dir/differs" | tr -d ' ')"
  head -5 "$dir/differs" | while IFS= read -r f; do
    if git cat-file -e "HEAD:./$f" 2>/dev/null || git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then echo "differs:t $f"; else echo "differs:u $f"; fi
  done
fi
rm -rf "$dir"
[ -n "$tree" ] || exit 0
from=$base
[ -n "$from" ] || from=HEAD
git diff --no-renames --numstat "$from" "$plain" 2>/dev/null | awk '{ files += 1; if ($1 != "-") lines += $1 + $2 } END { print "diff:" files + 0 " " lines + 0 }'
git -c core.quotePath=false diff --no-renames --name-only "$from" "$plain" 2>/dev/null | sed 's/^/file:/'
`;
var FIND_BASE = `
# devloop:find-base
git rev-parse --git-dir >/dev/null 2>&1 || { echo unknown; exit 0; }
current=$(git symbolic-ref --short -q HEAD 2>/dev/null)
base=""
if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  remoteHead=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  for ref in "origin/$1" "$1" "$remoteHead" origin/main main origin/master master; do
    [ -n "$ref" ] && [ "$ref" != "$current" ] || continue
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$ref" 2>/dev/null)
      break
    fi
  done
else
  base=$(git hash-object -t tree /dev/null)
fi
if [ -n "$2" ] && git merge-base --is-ancestor "$2" HEAD 2>/dev/null; then
  if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$2" 2>/dev/null; then base=$2; fi
fi
if [ -n "$base" ]; then echo "$base"; else echo unknown; fi
`;
var BASE_POLICY = `
# devloop:base-policy
git cat-file -e "$1:./devloop.json" 2>/dev/null || exit 3
git show "$1:./devloop.json"
`;
var CURRENT_BRANCH = `
# devloop:branch
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
if b=$(git symbolic-ref --short -q HEAD 2>/dev/null); then echo "branch:$b"; else echo "branch:(detached)"; fi
`;
var PUSH_RANGE = `
# devloop:push-range
git rev-parse -q --verify "origin/$1^{commit}" >/dev/null 2>&1 || { echo unknown; exit 0; }
src=$2
[ -n "$src" ] || src=HEAD
from=$(git merge-base "origin/$1" "$src" 2>/dev/null) || { echo unknown; exit 0; }
echo known
git -c core.quotePath=false diff --no-renames --name-only "$from" "$src" 2>/dev/null
`;
var LS_FILES = `
# devloop:ls-files
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
git -c core.quotePath=false ls-files -- "$@" 2>/dev/null | head -5000
`;
var SCRUBBED = `
# devloop:scrubbed
cmd=$1
shift
for n in "$@"; do
  shift
  case "$n" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
  v=$(printenv -- "$n") || continue
  set -- "$@" "$n=$v"
done
exec env -i "$@" bash --noprofile --norc -c "$cmd"
`;
var ADDED_LINES = `
# devloop:added-lines
dir=$(mktemp -d)
idx="$dir/index"
cp -p "$(git rev-parse --git-path index)" "$idx" 2>/dev/null
tree=$(GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
rm -rf "$dir"
[ -n "$tree" ] || exit 3
git -c core.quotePath=false diff -U0 --no-renames --no-ext-diff --no-textconv --no-color "$1" "$tree"
`;
var SWEEP_SKIPS = ["node_modules", "vendor", ".venv", "dist", "build", "target"];
var pathspecsOf = (globs) => globs.filter((glob) => glob.trim() !== "").map((glob) => `:(glob)${glob.includes("/") ? glob.replace(/^\.\//, "") : `**/${glob}`}`);
function sweepSpecsOf(cfg) {
  const specs = pathspecsOf(cfg.instructions);
  if (specs.length === 0) {
    return [];
  }
  const skips = [...SWEEP_SKIPS, ...cfg.instructionsIgnore].map((one) => one.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter((one) => one !== "");
  const excludes = skips.flatMap((one) => one.includes("/") ? [one, `${one}/**`] : [`**/${one}`, `**/${one}/**`]);
  return [...specs, ...[...new Set(excludes)].map((one) => `:(exclude,glob)${one}`)];
}
var NO_SNAPSHOT = { tree: null, committable: null, headTree: null, branch: null, head: null, base: null, files: [], size: { files: 0, lines: 0 }, ignored: {}, capped: null, hidden: [], differs: [], differCount: 0 };
var TAGGED = /^(tree|committable|headtree|branch|head|base|diff|ignored|capped|hidden|hiddencap|differcount|differs|file):/;
var HIDDEN_PAST_CAP = "more files with the skip-worktree or assume-unchanged bit on disk than the 100 the snapshot compares";
function readSnapshot(stdout) {
  const lines = stdout.split(`
`).filter((line) => line !== "");
  if (stdout.trim() === "") {
    return { ...NO_SNAPSHOT, isOutsideGit: true };
  }
  if (lines.some((line) => !TAGGED.test(line))) {
    return NO_SNAPSHOT;
  }
  const head = lines.filter((line) => !line.startsWith("file:"));
  const ignored = {};
  for (const line of head.filter((one) => one.startsWith("ignored:"))) {
    const cut = line.indexOf(" ");
    if (cut > 0) {
      ignored[line.slice(cut + 1)] = line.slice("ignored:".length, cut);
    }
  }
  const tagged = (tag) => head.find((line) => line.startsWith(`${tag}:`))?.slice(tag.length + 1) ?? "";
  const tree = tagged("tree");
  const base = tagged("base");
  const [files = 0, changedLines = 0] = tagged("diff").split(" ").map(Number);
  const capped = Number(tagged("capped"));
  const hidden = [...head.filter((line) => line.startsWith("hidden:")).map((line) => line.slice("hidden:".length)).filter((one) => one !== ""), ...head.some((line) => line.startsWith("hiddencap:")) ? [HIDDEN_PAST_CAP] : []];
  const differs = head.filter((line) => /^differs:[tu] ./.test(line)).map((line) => ({ path: line.slice("differs:t ".length), isUntracked: line.startsWith("differs:u") }));
  const differCount = Math.max(Number(tagged("differcount")) || 0, differs.length);
  const common = { branch: tagged("branch") || null, head: tagged("head") || null, base: base === "" || base === "unknown" ? null : base, headTree: tagged("headtree") || null, hidden, differs, differCount };
  return tree === "" ? { ...NO_SNAPSHOT, ...common } : { ...common, tree, committable: tagged("committable") || null, files: [...new Set(lines.filter((line) => line.startsWith("file:")).map((line) => line.slice("file:".length)))], size: { files, lines: changedLines }, ignored, capped: capped > 0 ? capped : null };
}
function checkArgv(command, scrub) {
  return scrub !== null && scrub.mode === "enforce" ? ["bash", "-c", SCRUBBED, "devloop", command, ...new Set([...CHECK_ENV_BASE, ...scrub.pass])] : ["bash", "-lc", command];
}
var INSTRUCTION_FILES = `
# devloop:instruction-files
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
git -c core.quotePath=false ls-files -c -- "$@" 2>/dev/null | head -400 | sed 's/^/t /'
git -c core.quotePath=false ls-files -o --exclude-standard -- "$@" 2>/dev/null | head -400 | sed 's/^/u /'
git -c core.quotePath=false ls-files -o -i --exclude-standard -- "$@" 2>/dev/null | awk -F/ '{ print NF "	" $0 }' | sort -s -n -k1,1 | cut -f2- | awk '{ if (NR <= 400) print "i " $0 } END { if (NR > 400) print "capped:" NR }'
`;
var FORMATTERS = [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js", ".editorconfig", "biome.json", ".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "rustfmt.toml", ".rustfmt.toml", "ruff.toml", ".clang-format", ".rubocop.yml", "deno.json"];
function readInstructionFiles(out) {
  const found = new Map;
  let capped = null;
  for (const line of out.split(`
`)) {
    if (line.startsWith("capped:")) {
      capped = Number(line.slice("capped:".length)) || null;
      continue;
    }
    const kind = line.slice(0, 1);
    const path = line.slice(2);
    if (path !== "" && (kind === "t" || kind === "u" || kind === "i") && !found.has(path)) {
      found.set(path, kind);
    }
  }
  return { files: [...found].map(([path, kind]) => ({ path, kind })), capped };
}

// cli/gate.ts
import { existsSync as existsSync2 } from "node:fs";

// cli/io.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import process from "node:process";
function exec(argv, cwd, timeoutMs = 30000, input) {
  const ran = spawnSync(argv[0] ?? "true", argv.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, ...input === undefined ? {} : { input } });
  const isTimeout = ran.error !== undefined && /ETIMEDOUT/.test(String(ran.error));
  return { code: ran.status ?? (ran.signal !== null ? 128 + 15 : 127), out: ran.stdout ?? "", err: ran.stderr ?? "", isTimeout };
}
var script = (text, args, cwd, timeoutMs = 30000) => exec(["bash", "-c", text, "devloop", ...args], cwd, timeoutMs);
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function realOf(path, where) {
  if (path.abs === null) {
    return [];
  }
  const starts = [...new Set([path.abs, ...path.raw === undefined ? [] : [physicalPath(path.raw, realOrNull)]])];
  const out = [];
  for (const abs of starts) {
    const real = realPathOf(abs);
    for (const one of [abs, ...real === null ? [] : [real]]) {
      if (one !== path.abs && !out.some((each) => each.abs === one)) {
        out.push(place(one, null, where));
      }
    }
  }
  return out;
}
function realPathOf(abs) {
  try {
    return realpathSync(abs);
  } catch {
    const cut = abs.lastIndexOf("/");
    try {
      const folder = realpathSync(cut <= 0 ? "/" : abs.slice(0, cut));
      return `${folder.replace(/\/$/, "")}/${abs.slice(cut + 1)}`;
    } catch {
      return null;
    }
  }
}
function realOrNull(folder) {
  try {
    return realpathSync(folder);
  } catch {
    return null;
  }
}
function findRoot(start) {
  const up = (test) => {
    for (let dir = start;; ) {
      if (test(dir)) {
        return dir;
      }
      const parent = dir.slice(0, dir.lastIndexOf("/"));
      if (parent === dir || dir === "" || dir === "/") {
        return null;
      }
      dir = parent === "" ? "/" : parent;
    }
  };
  const withPolicy = up((dir) => existsSync(`${dir}/devloop.json`));
  if (withPolicy !== null) {
    const text = readText(`${withPolicy}/devloop.json`) ?? "";
    const parsed = parseConfig(text);
    return { root: withPolicy, working: parsed.cfg, text, errors: parsed.errors, unused: parsed.unused };
  }
  return { root: up((dir) => existsSync(`${dir}/.git`)) ?? start, working: null, text: null, errors: [], unused: [] };
}
function findBase(root, branch) {
  const ran = script(FIND_BASE, [branch, ""], root);
  const said = ran.out.split(`
`)[0]?.trim() ?? "";
  return ran.code !== 0 || said === "" || said === "unknown" ? null : said;
}
function policyTextAt(root, base) {
  if (base === null) {
    return null;
  }
  const ran = script(BASE_POLICY, [base], root);
  return ran.code === 0 ? ran.out : null;
}
function policyInForce(found, base) {
  if (base !== undefined) {
    return { policy: decidePolicy(found.working, found.text, policyTextAt(found.root, base)), base };
  }
  const branch = found.working?.defaultBranch ?? parseConfig("{}").cfg.defaultBranch;
  let at = findBase(found.root, branch);
  let policy = decidePolicy(found.working, found.text, policyTextAt(found.root, at));
  if (policy !== null && policy.source === "base" && policy.cfg.defaultBranch !== branch) {
    const again = findBase(found.root, policy.cfg.defaultBranch);
    const next = decidePolicy(found.working, found.text, policyTextAt(found.root, again));
    if (next !== null && next.source === "base") {
      policy = next;
      at = again;
    }
  }
  return { policy, base: at };
}
function snapshot(root, cfg) {
  const ran = exec(["bash", "-c", SNAPSHOT, "devloop", cfg.defaultBranch, "", ...sweepSpecsOf(cfg)], root, 60000);
  return readSnapshot(ran.out);
}
function currentBranch(root) {
  const ran = script(CURRENT_BRANCH, [], root, 1e4);
  const line = ran.out.split(`
`).find((one) => one.startsWith("branch:"));
  return ran.code !== 0 || line === undefined || line === "branch:" ? null : line.slice("branch:".length).trim();
}
function filesUnder(root, dirs) {
  if (dirs.length === 0) {
    return {};
  }
  const ran = script(LS_FILES, dirs.map((dir) => dir === "" ? "." : dir), root);
  if (ran.code !== 0) {
    return {};
  }
  const files = ran.out.split(`
`).filter((line) => line !== "");
  return Object.fromEntries(dirs.map((dir) => [dir, files.filter((file) => dir === "" || file === dir || file.startsWith(`${dir}/`))]));
}
function pushRange(root, cfg, source) {
  const lines = script(PUSH_RANGE, [cfg.defaultBranch, source], root).out.split(`
`).filter((line) => line !== "");
  return lines[0] !== "known" ? null : lines.slice(1);
}
function remoteSlug(root, slug) {
  const ran = exec(["git", "remote", "get-url", "origin"], root, 1e4);
  return ran.code === 0 && ran.out.trim() !== "" ? slug(ran.out.trim()) : null;
}
function runCheck(command, root, cfg, capMs = null) {
  const limit = cfg.verifyTimeoutSec * 1000;
  const isCapped = capMs !== null && capMs < limit;
  const ran = exec(checkArgv(command, cfg.checkEnv), root, isCapped ? Math.max(1, capMs) : limit);
  if (ran.isTimeout) {
    return { isPassing: false, code: -1, outcome: "timeout", output: `No result within ${isCapped ? Math.round(capMs / 1000) : cfg.verifyTimeoutSec}s.`, isCut: isCapped };
  }
  const raw = `${ran.out}
${ran.err}`.slice(-1e5);
  return { isPassing: ran.code === 0, code: ran.code, outcome: classify(ran.code, raw), output: distill(raw), isCut: false };
}
function treeOf(root, commit) {
  const ran = exec(["git", "rev-parse", "-q", "--verify", `${commit}^{tree}`], root, 1e4);
  const said = ran.out.trim();
  return ran.code === 0 && /^[0-9a-f]{7,64}$/.test(said) ? said : null;
}
function whereFor(root, cwd, stateRoot) {
  const env = process.env;
  const named = Object.fromEntries(ENV_NAMES.filter((name) => name !== "HOME" && name !== "TMPDIR").map((name) => [name, env[name] || null]));
  return whereOf(root, cwd, { home: env.HOME ?? null, tmp: env.TMPDIR || null, stateRoot, env: named });
}
function globsFor(command, where) {
  const listings = new Map;
  const list = (dir) => {
    const known = listings.get(dir);
    if (known !== undefined) {
      return known;
    }
    let listing;
    try {
      listing = readdirSync(dir, { withFileTypes: true }).map((one) => ({ name: one.name, isDir: one.isDirectory() ? true : one.isSymbolicLink() ? null : false }));
    } catch {
      listing = null;
    }
    listings.set(dir, listing);
    return listing;
  };
  let at = where;
  for (let round = 0;round < GLOB_ROUNDS; round += 1) {
    const wanted = globsWanted(command, at);
    if (wanted.length === 0) {
      break;
    }
    at = globsAnswered(at, wanted, {
      reviewed: expandAllNow(patternsOf(wanted, "reviewed"), list, expandGlobReviewed),
      extended: expandAllNow(patternsOf(wanted, "extended"), list),
      spaced: expandAllNow(patternsOf(wanted, "spaced"), list)
    });
  }
  return at;
}
function onPath(program) {
  return (process.env.PATH ?? "").split(":").filter((dir) => dir !== "").some((dir) => existsSync(`${dir}/${program}`));
}
function tasksFacts(root, cfg) {
  if (cfg.tasks.integrate === "off") {
    return TASKS_OFF;
  }
  const isOn = isVersion2(readText(`${root}/${TASKS_DIR}/config.yml`)) && onPath("tasks");
  return { isOn, canFinish: null, finishWhy: "" };
}

// cli/gate.ts
var OK = 0;
var NOT_OK = 1;
var USAGE = 2;
function policyAtSnapshot(found, first, snap) {
  return snap.tree === null ? first : decidePolicy(found.working, found.text, policyTextAt(found.root, snap.base)) ?? first;
}
function notJudged(found, policy) {
  if (policy === null) {
    return { code: USAGE, text: `devloop: no devloop.json in ${found.root} or on its base branch: this repository has not opted in.`, json: { error: "not-opted-in", root: found.root } };
  }
  return null;
}
var factsFor = (found, policy, snap) => ({
  hiddenFromGit: snap.hidden,
  errors: found.errors,
  lint: lintChecks(policy.cfg.verify),
  policy: policy.policy,
  workingMode: policy.policy === "changed" && found.working !== null && found.working.mode !== policy.cfg.mode ? found.working.mode : null
});
function noteRead(root) {
  const ran = script(NOTE_READ, ["HEAD"], root);
  return ran.code === 0 ? { note: parseEvidence(ran.out), isOlder: isOlderEvidence(ran.out) } : { note: null, isOlder: false };
}
var OUT_OF_TIME = "out-of-time";
var outOfTime = (finished, left) => ({
  code: NOT_OK,
  text: `${finished.length === 0 ? "no check finished" : `finished: ${finished.map((one) => `${one.run} (${one.isPassing ? "passed" : "failed"})`).join(", ")}`}; not finished: ${left.join(", ")}`,
  json: { error: OUT_OF_TIME, finished: finished.map((one) => one.run), left }
});
function proveGate(found, budget = null) {
  const first = policyInForce(found).policy;
  const stop = notJudged(found, first);
  if (stop !== null || first === null) {
    return stop ?? { code: USAGE, text: "", json: null };
  }
  const snap = snapshot(found.root, first.cfg);
  if (snap.tree === null) {
    return { code: USAGE, text: `devloop: ${found.root} is not a git repository, so there is no tree to judge and no base to judge it against.`, json: { error: "not-git" } };
  }
  const policy = policyAtSnapshot(found, first, snap);
  const cfg = policy.cfg;
  const isEmpty = snap.files.length === 0 && snap.base !== null;
  const runs = [];
  const all = checksFor(cfg, snap.files, isEmpty);
  for (const [i, run] of all.entries()) {
    const left = budget === null ? null : budget.until - budget.now();
    if (left !== null && left <= 1000) {
      return outOfTime(runs, all.slice(i));
    }
    const ran = runCheck(run, found.root, cfg, left);
    if (ran.isCut) {
      return outOfTime(runs, all.slice(i));
    }
    runs.push({ run, isPassing: ran.isPassing, outcome: ran.outcome, output: ran.output });
  }
  const diff = script(ADDED_LINES, [snap.base ?? "HEAD"], found.root, 60000);
  const hidden = snap.files.filter((file) => matchesAny(file, instructionGlobs(cfg))).slice(0, 40).flatMap((file) => {
    const text = readText(`${found.root}/${file}`);
    return text === null ? [] : hiddenOf(file, text).map((one) => ({ file: one.file, line: one.line, kind: one.kind }));
  });
  const { note, isOlder } = noteRead(found.root);
  const proven = statelessGate({
    tree: snap.tree,
    committable: snap.committable,
    base: snap.base,
    files: snap.files,
    lines: snap.size.lines,
    runs,
    credentials: diff.code === 0 ? scanCredentials(addedLines2(diff.out)) : [],
    hidden,
    isScanned: diff.code === 0,
    note,
    isOlderNote: isOlder
  }, cfg, factsFor(found, policy, snap));
  return { policy, snap, tier: proven.loop.tier, rows: proven.rows, isGreen: proven.isGreen, runs, note };
}
var isSaid = (value) => ("code" in value);
function sendsRow(root, committable, pushing, seen) {
  const refused = pushSends(committable, pushing.map((commit) => ({ tree: treeOf(root, commit), isHead: commit === "HEAD" })), seen);
  return refused === null ? { label: "What the push sends", isMet: true, note: "the commits it sends hold the tree the gate judged" } : { label: "What the push sends", isMet: false, note: refused.reason };
}
function gateCommand(found, pushing = null) {
  const proven = proveGate(found);
  if (isSaid(proven)) {
    return proven;
  }
  const { policy, tier } = proven;
  const rows = pushing === null ? proven.rows : [sendsRow(found.root, proven.snap.committable, pushing, proven.snap), ...proven.rows];
  const isGreen = rows.every((row) => row.isMet);
  const cfg = policy.cfg;
  const lines = [
    `devloop gate: ${isGreen ? "green" : "not green"} (${tier === "none" ? "no changes" : `${tier} risk`}, judged by ${policy.policy === "no-base" ? "the working tree's" : "the base branch's"} devloop.json; stateless: no spec, no exemption, review only from a git note naming this tree)`,
    ...rows.map((check) => `  ${check.isMet ? "[x]" : "[ ]"} ${check.label}: ${check.note}`),
    tier === "none" ? "" : `  Merge: ${approvers(tier, cfg)} (${approvalsFor(tier, cfg)} approval${approvalsFor(tier, cfg) === 1 ? "" : "s"}; no state of the loop meets this row).`
  ].filter((line) => line !== "");
  return {
    code: isGreen ? OK : NOT_OK,
    text: lines.join(`
`),
    json: { isGreen, tier, tree: proven.snap.tree, committable: proven.snap.committable, base: proven.snap.base, policy: policy.policy, rows, approvals: approvalsFor(tier, cfg), evidence: proven.note === null ? null : { tree: proven.note.tree, head: proven.note.head, why: proven.note.why } }
  };
}
function verifyCommand(found, profile) {
  const first = policyInForce(found).policy;
  const stop = notJudged(found, first);
  if (stop !== null || first === null) {
    return stop ?? { code: USAGE, text: "", json: null };
  }
  const snap = snapshot(found.root, first.cfg);
  const cfg = policyAtSnapshot(found, first, snap).cfg;
  if (cfg.verify.length === 0) {
    return { code: NOT_OK, text: "devloop verify: devloop.json names no verify commands, so nothing proves the work.", json: { isPassing: false, runs: [] } };
  }
  const steps = stepsFor(cfg.verify, profile, snap.tree === null ? ["**"] : snap.files).map((one) => one.run);
  const runs = steps.map((run) => ({ run, ...runCheck(run, found.root, cfg) }));
  const failed = runs.filter((one) => !one.isPassing);
  return {
    code: failed.length === 0 ? OK : NOT_OK,
    text: [
      `devloop verify (${profile}): ${failed.length === 0 ? `passed${runs.length === 0 ? ": no check applies to this change" : ""}` : "failed"}`,
      ...runs.map((one) => `  ${one.isPassing ? "[pass]" : one.outcome === "fail" ? "[FAIL]" : `[${one.outcome}]`} ${one.run}`),
      ...failed.map((one) => `
${one.run}:
${one.output}`)
    ].join(`
`),
    json: { isPassing: failed.length === 0, profile, runs: runs.map((one) => ({ run: one.run, isPassing: one.isPassing, outcome: one.outcome, code: one.code })) }
  };
}
function instructionAudit(root, cfg) {
  const listed = script(INSTRUCTION_FILES, sweepSpecsOf(cfg), root);
  const paths = listed.code === 0 ? readInstructionFiles(listed.out).files.map((one) => one.path) : cfg.instructions.filter((glob) => !/[*?[]/.test(glob) && existsSync2(`${root}/${glob}`));
  const exists = (rel) => existsSync2(`${root}/${rel}`);
  const files = paths.slice(0, 200).flatMap((path) => {
    const text = readText(`${root}/${path}`);
    return text === null ? [] : [{ path, text }];
  });
  const existing = new Set;
  for (const { path, text } of files) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (const ref of referencedPaths(text).slice(0, 60)) {
      if (exists(ref) || folder !== "" && exists(`${folder}/${ref}`)) {
        existing.add(ref);
      }
    }
  }
  const scriptsAt = (dir) => {
    const text = readText(`${root}/${dir === "" ? "" : `${dir}/`}package.json`);
    if (text === null) {
      return null;
    }
    try {
      return Object.keys(JSON.parse(text).scripts ?? {});
    } catch {
      return [];
    }
  };
  const scriptsIn = {};
  for (const dir of [...new Set(files.flatMap((one) => namedCommands(one.text).map((each) => each.dir)))].filter((one) => one !== "" && one !== "?").slice(0, 20)) {
    scriptsIn[dir] = scriptsAt(dir);
  }
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find(exists);
  const items = lintInstructions({
    files,
    existing,
    scripts: scriptsAt(""),
    scriptsIn,
    targets: makefile === undefined ? null : makeTargets(readText(`${root}/${makefile}`) ?? ""),
    hasFormatter: FORMATTERS.some(exists),
    maxLines: cfg.instructionMaxLines,
    maxBytes: cfg.instructionMaxBytes
  });
  items.push(...lintSkills(files.filter((each) => /(^|\/)SKILL\.md$/.test(each.path)).map((one) => {
    const folder = one.path.slice(0, Math.max(0, one.path.lastIndexOf("/")));
    return { ...one, hasMcp: exists(`${folder === "" ? "" : `${folder}/`}.mcp.json`) };
  })));
  items.push(...lintInjection(files));
  return items;
}
function sandboxAudit(root, cfg, stateRoot) {
  const files = [".claude/settings.json", ".claude/settings.local.json"].map((name) => ({ name, text: readText(`${root}/${name}`) }));
  const { found, errors } = sandboxOf2(files);
  return [
    ...errors.map((text) => ({ level: "warn", text: `sandbox: ${text}` })),
    ...compareSandbox(found, cfg, stateRoot, { home: process2.env.HOME ?? null, pathDirs: (process2.env.PATH ?? "").split(":") })
  ];
}
function doctorCommand(found, isStrict, stateRoot) {
  const policy = policyInForce(found).policy;
  const out = [];
  let errors = 0;
  const say = (item) => {
    errors += item.level === "error" ? 1 : 0;
    out.push(`  ${item.level === "ok" ? "[ok]  " : item.level === "warn" ? "[look]" : "[error]"} ${item.text}`);
  };
  if (policy === null) {
    say({ level: "warn", text: `no devloop.json in ${found.root} or on its base branch: not opted in` });
  } else {
    say({ level: "ok", text: policy.source === "base" ? `policy in force: the base branch's devloop.json, whole (mode ${policy.cfg.mode})${policy.policy === "changed" ? "; the working tree's copy differs" : policy.policy === "deleted" ? "; the working tree's copy was deleted" : ""}` : "policy in force: the working tree's devloop.json (the base branch has none)" });
    for (const error of found.errors) {
      say({ level: "error", text: `devloop.json: ${error}` });
    }
    if (found.unused.length > 0) {
      say({ level: "ok", text: `devloop.json sets fields this version does not read, ignored: ${found.unused.join(", ")}` });
    }
    say({ level: "ok", text: `grounding: ${groundingMode(policy.cfg)}${policy.cfg.grounding.mode === null ? " (following the policy's mode)" : ""}; judged at a turn's end by the hooks module and the classic hooks; the command line has no turn, so it has nothing to judge` });
    for (const problem of lintChecks(policy.cfg.verify)) {
      say({ level: "warn", text: `check integrity: ${problem}` });
    }
    for (const item of instructionAudit(found.root, found.working ?? policy.cfg)) {
      say(item);
    }
    for (const item of sandboxAudit(found.root, policy.cfg, stateRoot)) {
      say(item);
    }
  }
  out.push("  not checked here (the plugin's doctor reads them): the tools in context, the session's context window, the store's records, the spec library (its folder is kept in the store)");
  out.push("  accepted residual risks (docs/RESIDUAL-RISK.md):");
  for (const one of RESIDUAL_RISKS) {
    out.push(`    ${one.id} ${one.line}`);
  }
  return {
    code: isStrict && errors > 0 ? NOT_OK : policy === null ? USAGE : OK,
    text: ["devloop doctor (stateless)", ...out, isStrict ? `strict: ${errors} error-level item${errors === 1 ? "" : "s"}` : ""].filter((line) => line !== "").join(`
`),
    json: { errors, isOptedIn: policy !== null, lines: out }
  };
}
function sandboxCommand(found, stateRoot, isStateKnown = true) {
  const policy = policyInForce(found).policy;
  if (policy === null) {
    return { code: USAGE, text: `devloop: no devloop.json in ${found.root} or on its base branch: this repository has not opted in.`, json: { error: "not-opted-in" } };
  }
  const block = sandboxSettings(policy.cfg, stateRoot);
  const broad = (policy.cfg.network?.allow ?? []).filter(isBroadDomain);
  const warnings = [
    ...isStateKnown ? [] : [`the harness's state directory could not be determined here (CLAUDE_PLUGIN_DATA is not set), so ${stateRoot} in denyWrite is the fallback, not necessarily where the plugin keeps its state: run this where the plugin runs, or put the plugin's data folder there yourself.`],
    ...broad.map((domain) => `the allowed domain ${domain} is broad enough to defeat the allow-list (anyone can publish under it): name the exact hosts instead.`)
  ];
  return {
    code: OK,
    text: [
      "// The sandbox settings that match devloop.json (the policy in force). Nothing was written:",
      "// merge this into .claude/settings.json yourself. Globs are given as the policy writes them.",
      ...warnings.map((one) => `// warning: ${one}`),
      JSON.stringify(block, null, 2),
      policy.cfg.network === null ? "// devloop.json sets no network.allow, so no allowed domains are implied: add sandbox.network.allowedDomains yourself." : ""
    ].filter((line) => line !== "").join(`
`),
    json: block,
    warnings: warnings.map((one) => `devloop sandbox: warning: ${one}`)
  };
}

// cli/hook.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2, unlinkSync, writeFileSync } from "node:fs";
import process3 from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

// cli/judge.ts
import { statSync } from "node:fs";
function shellWhere(text, base, root, isOptedIn) {
  const where = globsFor(text, base);
  const written = writtenPaths(text, where);
  const dirs = [];
  for (const one of written.slice(0, 16)) {
    const isGlob = /[*?[]/.test(one.rel ?? "");
    const rel = one.rel === null ? null : globParts(one.rel).dir;
    if (rel !== null && (rel !== "" || isGlob) && dirs.length < 8 && !dirs.includes(rel)) {
      dirs.push(rel);
    }
  }
  const folders = {};
  for (const rel of dirs.filter((one) => one !== "")) {
    try {
      folders[rel] = statSync(`${root}/${rel}`).isDirectory();
    } catch (error) {
      if (/ENOENT/.test(String(error))) {
        folders[rel] = false;
      }
    }
  }
  const ships = shipLookups(text);
  const branch = ships.hasMerge || ships.isShip ? currentBranch(root) : null;
  const remote = ships.hasRepoFlag ? remoteSlug(root, repoSlug) : null;
  return { ...where, filesUnder: isOptedIn ? filesUnder(root, dirs) : {}, folders, branch, remote };
}
function judgeOne(call, cfg, isOptedIn, base, root, phase = "idle") {
  const isShell = call.tool === "Bash" || call.tool === "Monitor";
  const text = isShell && typeof call.input.command === "string" ? call.input.command : "";
  const where = { ...isShell ? shellWhere(text, base, root, isOptedIn) : base, ...isOptedIn ? { tasks: tasksFacts(root, cfg) } : {} };
  const all = judgeCall(call, { cfg, isOptedIn, where, loop: statelessLoop(phase), realOf: (path) => realOf(path, where), readText });
  let ships = false;
  let isPush = false;
  if (isShell && all.length === 0 && isOptedIn) {
    const intents = shippingOf(text, where.branch, cfg.defaultBranch);
    isPush = intents.some((one) => one.kind === "push");
    if (intents.length > 0) {
      const ranges = {};
      for (const source of pushesToDefault(intents, where.branch, cfg.defaultBranch)) {
        ranges[source] = pushRange(root, cfg, source);
      }
      const needsTier = intents.some((one) => one.kind === "pr-merge");
      const snap = needsTier ? snapshot(root, cfg) : null;
      const tier = snap === null || snap.tree === null ? "medium" : tierWithBlast(snap.files, snap.size.lines, cfg);
      const before = shipRules(intents, where.branch, cfg, tier, ranges);
      if (before !== null) {
        all.push(before);
      } else {
        ships = true;
      }
    }
  }
  const verdict = strictest(all, cfg);
  return { verdict, isHeld: verdict !== null && isHeldBy(verdict.rule, cfg), all, ships, isPush };
}
function verdictLines(judged, mode) {
  if (judged.verdict === null) {
    return [judged.ships ? "allowed by the rules; it ships, so the gate decides (node dist/devloop.mjs gate)" : "allowed: no rule refuses it"];
  }
  const { rule, reason } = judged.verdict;
  return [
    `${judged.isHeld ? "refused" : "recorded only (observe mode)"}: ${rule}${judged.verdict.id !== undefined ? ` (${judged.verdict.id})` : ""}`,
    `reason: ${reason}`,
    `lift class: ${liftOf(rule)}`,
    `mode in force: ${mode}`
  ];
}

// cli/hook.ts
var SHIP_BUDGET_MS = 240000;
var str2 = (value) => typeof value === "string" ? value : "";
var pendingNotice = null;
var answer = (value) => {
  let out = value;
  if (pendingNotice !== null && typeof value === "object" && value !== null) {
    const said = value.systemMessage;
    out = { ...value, systemMessage: typeof said === "string" && said !== "" ? `${pendingNotice}
${said}` : pendingNotice };
    pendingNotice = null;
  }
  process3.stdout.write(`${JSON.stringify(out)}
`);
};
function flushNotice() {
  if (pendingNotice !== null) {
    answer({});
  }
}
function ensureDir(file) {
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
}
function pruneStamps(dir) {
  try {
    const names = readdirSync2(dir);
    if (names.length <= STAMPS_KEPT + 50) {
      return;
    }
    const aged = names.map((name) => ({ name, at: statSync2(`${dir}/${name}`).mtimeMs })).sort((a, b) => a.at - b.at);
    for (const one of aged.slice(0, aged.length - STAMPS_KEPT)) {
      unlinkSync(`${dir}/${one.name}`);
    }
  } catch {}
}
function policyFor(found, stateRoot) {
  const branch = found.working?.defaultBranch ?? DEFAULTS.defaultBranch;
  let base = findBase(found.root, branch);
  let baseText = policyTextAt(found.root, base);
  let policy = decidePolicy(found.working, found.text, baseText);
  if (policy !== null && policy.source === "base" && policy.cfg.defaultBranch !== branch) {
    const again = findBase(found.root, policy.cfg.defaultBranch);
    const text = policyTextAt(found.root, again);
    const next = decidePolicy(found.working, found.text, text);
    if (next !== null && next.source === "base") {
      policy = next;
      base = again;
      baseText = text;
    }
  }
  const secrets = baseText === null ? null : parseConfig(baseText).cfg.secrets;
  if (secrets !== null) {
    try {
      const file = secretsFile(stateRoot, found.root);
      ensureDir(file);
      writeFileSync(file, JSON.stringify({ secrets }));
    } catch {}
  }
  return { policy, base };
}
var secretsFile = (stateRoot, root) => `${repoStateDir(stateRoot, root)}/classic-secrets.json`;
function anySecrets(found, stateRoot) {
  let base = [];
  try {
    const kept = JSON.parse(readFileSync2(secretsFile(stateRoot, found.root), "utf8"));
    base = Array.isArray(kept.secrets) ? kept.secrets.filter((one) => typeof one === "string") : [];
  } catch {
    base = [];
  }
  return { ...DEFAULTS, secrets: [...DEFAULTS.secrets, ...found.working?.secrets ?? [], ...base], secretsAllow: [] };
}
var INBOX_MAX_BYTES = 2000000;
function toInbox(stateRoot, root, event) {
  try {
    const file = inboxPath(stateRoot, root);
    ensureDir(file);
    if (existsSync3(file) && statSync2(file).size > INBOX_MAX_BYTES) {
      return;
    }
    appendFileSync(file, `${JSON.stringify(event)}
`);
  } catch {}
}
var outOfTimeReason = (progress) => `The checks did not finish within the classic hook's time budget (${SHIP_BUDGET_MS / 1000}s), so nothing ships on this call: ${progress}. Nothing is kept between runs, so a retry runs every check again. Ways forward: push from a session with devloop's hooks module loaded (it proves the gate with its own record of passes), let the command-line gate (node dist/devloop.mjs gate) judge the push in CI, or ask a person to push.`;
var NOT_LOADED = "devloop: the full harness (its hooks module) is not loaded in this session, so only the stateless core holds, from the classic hooks: secrets, protected and harness paths, production, forbidden, destructive and egress commands, --no-verify and forced pushes, ship-alone, merges, content rules that refuse, test weakening on edits, and the fast checks at each stop. There is no spec approval, feature status, review loop or exemption: high-risk paths cannot be edited, and a medium or high-risk change cannot ship without review evidence (a git note naming its tree).";
function noticeOnce(stateRoot, session) {
  if (session === "") {
    return null;
  }
  const file = noticePath(stateRoot, session);
  if (existsSync3(file)) {
    return null;
  }
  try {
    ensureDir(file);
    writeFileSync(file, String(Date.now()));
  } catch {
    return null;
  }
  return NOT_LOADED;
}
function preToolUse(input, stateRoot) {
  const tool = str2(input.tool_name);
  if (!JUDGED_TOOLS.includes(tool)) {
    return;
  }
  const id = str2(input.tool_use_id);
  const stamp = id === "" ? null : stampPath(stateRoot, id);
  if (stamp !== null && existsSync3(stamp)) {
    try {
      unlinkSync(stamp);
    } catch {}
    pruneStamps(stamp.slice(0, stamp.lastIndexOf("/")));
    return;
  }
  const session = str2(input.session_id);
  const state = session !== "" && existsSync3(heartbeatPath(stateRoot, session)) ? "skipped" : "absent";
  const cwd = str2(input.cwd) || process3.cwd();
  const found = findRoot(cwd);
  const call = { tool, input: typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {} };
  if (tool === "Read" || SEARCH_TOOLS.includes(tool)) {
    const where = whereFor(found.root, cwd, stateRoot);
    const loose = judgeCall(call, { cfg: anySecrets(found, stateRoot), isOptedIn: false, where, loop: statelessLoop(), realOf: (path) => realOf(path, where), readText });
    if (!loose.some((one) => one.rule === "secret")) {
      return;
    }
  }
  const { policy } = policyFor(found, stateRoot);
  if (policy === null) {
    const bare = whereFor(found.root, cwd, stateRoot);
    const where = SHELL_TOOLS.includes(tool) ? globsFor(commandOf(call), bare) : bare;
    const secret = judgeCall(call, { cfg: DEFAULTS, isOptedIn: false, where, loop: statelessLoop(), realOf: (path) => realOf(path, where), readText }).find((one) => one.rule === "secret");
    if (secret !== undefined) {
      answer({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `devloop (classic hook): [secret] ${secret.reason} ${liftClause("secret")}` } });
    }
    return;
  }
  const cfg = policy.cfg;
  const where = whereFor(found.root, cwd, stateRoot);
  const judged = judgeOne(call, cfg, true, where, found.root);
  const event = (kind, rule) => ({ at: Date.now(), kind, session, tool, subject: (tool === "Bash" || tool === "Monitor" ? str2(call.input.command) : filePathOf(call) || str2(call.input.pattern)).slice(0, 80), rule });
  if (state === "skipped") {
    toInbox(stateRoot, found.root, event("module-skipped", judged.verdict?.rule ?? null));
  }
  const notice = state === "absent" ? noticeOnce(stateRoot, session) : null;
  if (notice !== null) {
    toInbox(stateRoot, found.root, event("module-absent", null));
  }
  let deny = null;
  if (judged.isHeld && judged.verdict !== null) {
    deny = `[${judged.verdict.rule}${judged.verdict.id === undefined ? "" : `:${judged.verdict.id}`}] ${judged.verdict.reason} ${liftClause(judged.verdict.rule)}`;
    toInbox(stateRoot, found.root, event("classic-refusal", judged.verdict.id ?? judged.verdict.rule));
  } else if (judged.ships && judged.verdict === null) {
    if (state === "skipped") {
      deny = "[gate] The harness could not judge this call (its hook did not run for it), so nothing ships on it: run it again. The skip was recorded for the person.";
    } else {
      const snap = judged.isPush ? snapshot(found.root, cfg) : null;
      const sends = snap === null ? null : pushSends(snap.committable, [{ tree: snap.headTree, isHead: true }], snap);
      if (sends !== null) {
        deny = cfg.mode === "enforce" ? `[gate] ${sends.reason}` : null;
      } else {
        const proven = proveGate(found, { until: Date.now() + SHIP_BUDGET_MS, now: () => Date.now() });
        if ("code" in proven) {
          const isOutOfTime = proven.json?.error === OUT_OF_TIME;
          deny = cfg.mode !== "enforce" ? null : isOutOfTime ? `[gate] ${outOfTimeReason(proven.text)}` : `[gate] The gate could not be proven here, so nothing ships yet: ${proven.text}`;
        } else if (!proven.isGreen && cfg.mode === "enforce") {
          deny = `[gate] The gate is not green, so nothing ships yet. Still needed: ${proven.rows.filter((row) => !row.isMet).map((row) => `${row.label} (${row.note})`).join("; ")}.`;
        }
      }
      if (deny !== null) {
        toInbox(stateRoot, found.root, event("classic-refusal", "gate"));
      }
    }
  }
  if (deny !== null) {
    answer({
      ...notice === null ? {} : { systemMessage: notice },
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `devloop (classic hook): ${deny}` }
    });
    return;
  }
  if (notice !== null) {
    answer({ systemMessage: notice, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notice } });
  }
}
function sessionCheckOf(root, cfg, session) {
  if (session === "" || !tasksFacts(root, cfg).isOn) {
    return null;
  }
  const ran = exec(["tasks", "session-check", "--json", "--session", session], root, 30000);
  return sessionCheckProblems(ran.code, `${ran.out}
${ran.err}`);
}
function stop(input, stateRoot) {
  if (str2(input.agent_id) !== "") {
    return;
  }
  const session = str2(input.session_id);
  const stamp = session === "" ? null : stopStampPath(stateRoot, session);
  if (stamp !== null && readText(stamp)?.trim() === stopKey(input)) {
    try {
      unlinkSync(stamp);
    } catch {}
    return;
  }
  const state = session !== "" && existsSync3(heartbeatPath(stateRoot, session)) ? "skipped" : "absent";
  const found = findRoot(str2(input.cwd) || process3.cwd());
  const { policy } = policyFor(found, stateRoot);
  if (policy === null) {
    return;
  }
  const snap = snapshot(found.root, policy.cfg);
  const stopFile = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`;
  let seen = { blocked: null, rounds: 0, prompt: "" };
  try {
    seen = { ...seen, ...JSON.parse(readFileSync2(stopFile, "utf8")) };
  } catch {}
  const thisPrompt = str2(input.prompt_id);
  const isQuiet = snap.tree !== null && seen.lastTree === snap.tree && seen.lastPrompt !== thisPrompt && input.stop_hook_active !== true && seen.blocked !== snap.tree;
  try {
    ensureDir(stopFile);
    writeFileSync(stopFile, JSON.stringify({ ...seen, lastTree: snap.tree, lastPrompt: thisPrompt }));
  } catch {}
  const grounded = groundingAtStop(input, policy.cfg, snap.tree !== null && typeof seen.lastTree === "string" && seen.lastTree !== snap.tree);
  if (grounded !== null && "block" in grounded) {
    answer({ decision: "block", reason: grounded.block });
    return;
  }
  if (grounded !== null) {
    pendingNotice = grounded.notice;
    toInbox(stateRoot, found.root, { at: Date.now(), kind: "answer-unchecked", session, tool: "Stop", subject: grounded.prompt, rule: null });
  }
  if (isQuiet) {
    return;
  }
  const tasksFile = stopFile;
  const problem = sessionCheckOf(found.root, policy.cfg, session);
  if (problem !== null) {
    let record = { blocked: null, rounds: 0, prompt: "" };
    try {
      record = { ...record, ...JSON.parse(readFileSync2(tasksFile, "utf8")) };
    } catch {}
    const prompt = str2(input.prompt_id);
    if (!isHeldBy("tasks", policy.cfg) || record.tasksBlocked === prompt) {
      answer({ systemMessage: `devloop (classic hook): the .tasks session check fails: ${problem}` });
      return;
    }
    try {
      ensureDir(tasksFile);
      writeFileSync(tasksFile, JSON.stringify({ ...record, tasksBlocked: prompt }));
    } catch {}
    answer({ decision: "block", reason: `devloop (classic hook): the .tasks session check fails, so work is not left as it is: ${problem}

Write each claimed task's resume point (\`tasks state <task>\`), or pause or hand it over (\`tasks pause|handoff <task> -m "…"\`), then stop.` });
    return;
  }
  if (policy.cfg.verify.length === 0) {
    return;
  }
  if (snap.tree === null) {
    return;
  }
  const cfg = (decidePolicy(found.working, found.text, policyTextAt(found.root, snap.base)) ?? policy).cfg;
  const file = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`;
  const prompt = str2(input.prompt_id);
  let kept = { blocked: null, rounds: 0, prompt };
  try {
    kept = { ...kept, ...JSON.parse(readFileSync2(file, "utf8")) };
  } catch {}
  if (kept.prompt !== prompt) {
    kept = { ...kept, rounds: 0, blocked: null, prompt };
  }
  const keep = () => {
    try {
      ensureDir(file);
      writeFileSync(file, JSON.stringify(kept));
    } catch {}
  };
  const event = (kind) => ({ at: Date.now(), kind, session, tool: "Stop", subject: "the stop gate", rule: null });
  if (state === "skipped") {
    toInbox(stateRoot, found.root, event("module-skipped"));
  }
  if (snap.tree === kept.blocked) {
    kept = { ...kept, blocked: null };
    keep();
    answer({ systemMessage: "devloop (classic hook): the agent stopped again with nothing changed since the last blocked stop; verification still fails. This needs you." });
    return;
  }
  const steps = stepsFor(cfg.verify, "fast", snap.files);
  const runs = steps.map((one) => ({ run: one.run, ...runCheck(one.run, found.root, cfg) }));
  const failed = runs.find((one) => !one.isPassing);
  if (failed === undefined) {
    kept = { ...kept, blocked: null };
    keep();
    return;
  }
  if (failed.outcome !== "fail") {
    const advice = infraAdvice(failed.run, failed.outcome, cfg.verifyTimeoutSec);
    answer({ systemMessage: `devloop (classic hook): ${advice}` });
    return;
  }
  if (cfg.mode === "observe") {
    answer({ systemMessage: `devloop (classic hook, observe): verification is failing: ${failed.run}` });
    return;
  }
  if (kept.rounds >= cfg.maxFixRounds) {
    answer({ systemMessage: `devloop (classic hook): still failing after ${cfg.maxFixRounds} fix rounds. This one needs you.` });
    return;
  }
  kept = { ...kept, rounds: kept.rounds + 1, blocked: snap.tree };
  keep();
  answer({
    decision: "block",
    reason: [
      `devloop (classic hook): verification failed, so the work is not done (fix round ${kept.rounds} of ${cfg.maxFixRounds}).`,
      `\`${failed.run}\` exited ${failed.code}.`,
      distill(failed.output),
      "Fix the cause; never weaken a test to get green."
    ].join(`

`)
  });
}
var TRANSCRIPT_TAIL = 8 * 1024 * 1024;
function groundingAtStop(input, cfg, isTreeChanged) {
  const mode = groundingMode(cfg);
  const path = str2(input.transcript_path);
  if (mode === "off" || path === "") {
    return null;
  }
  let text = null;
  try {
    const size = statSync2(path).size;
    const all = readFileSync2(path, "utf8");
    text = size > TRANSCRIPT_TAIL ? all.slice(all.indexOf(`
`, all.length - TRANSCRIPT_TAIL) + 1) : all;
  } catch {
    return null;
  }
  const turn = lastTurn(text);
  if (turn === null || !turn.isPerson) {
    return null;
  }
  const verdict = backstop({
    mode,
    isQuestion: isQuestionOfFact(turn.prompt, cfg.grounding.also, cfg.grounding.never),
    looks: looksIn(turn.calls),
    isTreeChanged,
    isFreshLook: false,
    isRefused: input.stop_hook_active === true,
    answer: str2(input.last_assistant_message)
  });
  if (verdict.action === "refuse") {
    return { block: `devloop (classic hook): ${verdict.reason}` };
  }
  if (verdict.action === "report") {
    const prompt = firstLine(turn.prompt);
    return { notice: `devloop (classic hook): ${verdict.toast} (asked: "${prompt.slice(0, 80)}")`, prompt };
  }
  return null;
}
function userPromptSubmit(input, stateRoot) {
  const session = str2(input.session_id);
  const prompt = str2(input.prompt);
  const stamp = session === "" ? null : promptStampPath(stateRoot, session);
  if (stamp !== null && readText(stamp)?.trim() === digest(prompt)) {
    try {
      unlinkSync(stamp);
    } catch {}
    return;
  }
  const source = str2(input.source);
  if (source !== "" && source !== "user" && source !== "sdk") {
    return;
  }
  const found = findRoot(str2(input.cwd) || process3.cwd());
  const { policy } = policyFor(found, stateRoot);
  if (policy === null || groundingMode(policy.cfg) === "off" || !isQuestionOfFact(prompt, policy.cfg.grounding.also, policy.cfg.grounding.never)) {
    return;
  }
  answer({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `devloop: ${NUDGE}` } });
}
var READ_DEADLINE_MS = 60000;
function readStdin(deadlineMs = READ_DEADLINE_MS) {
  return new Promise((resolve) => {
    const chunks = [];
    let isDone = false;
    const finish = (value) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      finish({ error: `its input did not end within ${Math.round(deadlineMs / 1000)}s` });
      process3.stdin.destroy();
    }, deadlineMs);
    process3.stdin.setEncoding("utf8");
    process3.stdin.on("data", (chunk) => chunks.push(chunk));
    process3.stdin.on("end", () => finish({ text: chunks.join("") }));
    process3.stdin.on("error", (error) => finish({ error: `its input could not be read (${String(error)})` }));
  });
}
function parseInput(event, text) {
  if (text.trim() === "") {
    return { error: "its input was empty" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `its input is not complete JSON (${text.length} characters read)` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "its input is not a JSON object" };
  }
  const input = value;
  if (event === "PreToolUse" && typeof input.tool_name !== "string") {
    return { error: "its input names no tool" };
  }
  return { input };
}
function markStopError(stateRoot, cwd, why) {
  try {
    const found = findRoot(cwd);
    const file = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`;
    let kept = { blocked: null, rounds: 0, prompt: "" };
    try {
      kept = { ...kept, ...JSON.parse(readFileSync2(file, "utf8")) };
    } catch {}
    ensureDir(file);
    writeFileSync(file, JSON.stringify({ ...kept, error: why.slice(0, 200) }));
  } catch {}
}
function couldNotJudge(event, why, stateRoot, cwd, isRead) {
  if (event === "PreToolUse") {
    answer({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `devloop (classic hook): the harness ${isRead ? "could not read this call" : "could not judge this call"} (${why}), so it is refused: an enforcement point that cannot judge its input refuses. Run it again; if this repeats, a person runs node dist/devloop.mjs doctor.`
      }
    });
  } else if (event === "Stop") {
    markStopError(stateRoot, cwd, why);
    answer({ systemMessage: `devloop (classic hook): the stop gate ${isRead ? "could not read its input" : "failed"} (${why}), so verification did not run on this stop and counts as not done. Run node dist/devloop.mjs verify, or ask the agent to stop again.` });
  }
}
function modeAfterError(input, stateRoot) {
  try {
    const found = findRoot(str2(input.cwd) || process3.cwd());
    const { policy } = policyFor(found, stateRoot);
    return policy === null ? "dormant" : policy.cfg.mode;
  } catch {
    return null;
  }
}
async function hookCommand(event) {
  const stateRoot = stateRootFrom(process3.env.CLAUDE_PLUGIN_DATA);
  if (event !== "PreToolUse" && event !== "Stop" && event !== "UserPromptSubmit") {
    process3.stderr.write(`devloop classic hook: unknown event ${event}
`);
    return 0;
  }
  const read = await readStdin();
  const parsed = "error" in read ? read : parseInput(event, read.text);
  if ("error" in parsed) {
    if (event !== "UserPromptSubmit") {
      couldNotJudge(event, parsed.error, stateRoot, process3.cwd(), true);
    }
    return 0;
  }
  const input = parsed.input;
  try {
    if (event === "PreToolUse") {
      preToolUse(input, stateRoot);
    } else if (event === "UserPromptSubmit") {
      userPromptSubmit(input, stateRoot);
    } else {
      stop(input, stateRoot);
      flushNotice();
    }
  } catch (error) {
    if (event === "UserPromptSubmit") {
      process3.stderr.write(`devloop classic hook: ${String(error)}
`);
      return 0;
    }
    process3.stderr.write(`devloop classic hook: ${String(error)}
`);
    const tool = str2(input.tool_name);
    const why = String(error).slice(0, 200);
    if (event === "Stop") {
      couldNotJudge(event, why, stateRoot, str2(input.cwd) || process3.cwd(), false);
    } else if (JUDGED_TOOLS.includes(tool)) {
      const mode = modeAfterError(input, stateRoot);
      const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
      if (mode === "enforce" || mode === null) {
        couldNotJudge(event, why, stateRoot, str2(input.cwd) || process3.cwd(), false);
      } else if (namesDefaultSecret(tool, toolInput)) {
        answer({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "devloop (classic hook): this names a file that holds secrets; it is never read or written from here." } });
      } else if (mode === "observe") {
        answer({ systemMessage: `devloop (classic hook, observe): the hook failed on this call (${why}); in enforce mode it would have been refused.` });
      }
    }
  }
  return 0;
}

// cli/main.ts
var USE = `devloop ${HARNESS_VERSION}: the devloop policy with no agent (node dist/devloop.mjs <command>)

  gate [--pushing <commit>…]    prove the gate from the tree: checks, tier, blast radius, tests and
                                instruction files changed, the credential scan, policy changed,
                                check integrity; review only from a git note naming this tree
  verify [--profile fast|full]  run the base policy's checks for the change (full by default)
  doctor [--strict]             policy errors, instruction and skill lints, the injection scan, the
                                sandbox settings against the policy (--strict: exit 1 on an error)
  sandbox                       print the sandbox settings that match the policy (writes nothing)
  check-command '<text>' [--phase idle|spec|build]
  check-path <path> [--write | --content <text>] [--phase idle|spec|build]
                                the verdict the guards would give: rule, reason, lift class
  hook <event>                  a classic hook: PreToolUse, UserPromptSubmit or Stop (reads the hook's JSON on standard input)
  version                       the harness version

  --json   one JSON value instead of text
  Exit: 0 ok, 1 not ok, 2 usage or policy error.`;
function flag(args, name) {
  const at = args.indexOf(name);
  if (at < 0) {
    return null;
  }
  const value = args[at + 1] ?? "";
  args.splice(at, 2);
  return value;
}
function phaseOf(args) {
  const value = flag(args, "--phase");
  return value === null ? "idle" : value === "idle" || value === "spec" || value === "build" ? value : null;
}
function check2(kind, args) {
  const phase = phaseOf(args);
  const content = flag(args, "--content");
  const isWrite = args.includes("--write") || content !== null;
  const operands = args.filter((one) => one !== "--write");
  const subject = operands[0];
  if (phase === null || subject === undefined || operands.length !== 1) {
    return { code: USAGE, text: kind === "command" ? "usage: check-command '<text>' [--phase idle|spec|build]" : "usage: check-path <path> [--write | --content <text>] [--phase idle|spec|build]", json: { error: "usage" } };
  }
  const cwd = process4.cwd();
  const found = findRoot(cwd);
  const policy = policyInForce(found).policy;
  const cfg = policy?.cfg ?? DEFAULTS;
  const stateRoot = stateRootFrom(process4.env.CLAUDE_PLUGIN_DATA);
  const where = whereFor(found.root, cwd, stateRoot);
  const call = kind === "command" ? { tool: "Bash", input: { command: subject } } : content !== null ? { tool: "Write", input: { file_path: subject, content } } : isWrite ? { tool: "Edit", input: { file_path: subject, old_string: "\x00devloop-check-path", new_string: "" } } : { tool: "Read", input: { file_path: subject } };
  const judged = judgeOne(call, cfg, policy !== null, where, found.root, phase);
  const mode = policy === null ? "off (no devloop.json: only secrets are judged)" : cfg.mode;
  return {
    code: judged.isHeld ? NOT_OK : OK,
    text: verdictLines(judged, mode).join(`
`),
    json: {
      rule: judged.verdict?.rule ?? null,
      id: judged.verdict?.id ?? null,
      reason: judged.verdict?.reason ?? null,
      lift: judged.verdict === null ? null : liftOf(judged.verdict.rule),
      isHeld: judged.isHeld,
      ships: judged.ships,
      mode: policy === null ? "off" : cfg.mode,
      phase
    }
  };
}
function main(argv) {
  const args = [...argv];
  const isJson = args.includes("--json");
  const rest = args.filter((one) => one !== "--json");
  const [name = "", ...more] = rest;
  const stateRoot = stateRootFrom(process4.env.CLAUDE_PLUGIN_DATA);
  let said;
  switch (name) {
    case "hook":
      return hookCommand(more[0] ?? "");
    case "version":
      said = { code: OK, text: HARNESS_VERSION, json: { version: HARNESS_VERSION } };
      break;
    case "gate": {
      const at = more.indexOf("--pushing");
      const pushing = at < 0 ? null : more.slice(at + 1).filter((one) => one !== "");
      said = pushing !== null && pushing.length === 0 ? { code: USAGE, text: "usage: gate [--pushing <commit>…]", json: { error: "usage" } } : gateCommand(findRoot(process4.cwd()), pushing);
      break;
    }
    case "verify": {
      const profile = flag(more, "--profile") ?? "full";
      said = profile === "fast" || profile === "full" ? verifyCommand(findRoot(process4.cwd()), profile) : { code: USAGE, text: "usage: verify [--profile fast|full]", json: { error: "usage" } };
      break;
    }
    case "doctor":
      said = doctorCommand(findRoot(process4.cwd()), more.includes("--strict"), stateRoot);
      break;
    case "sandbox":
      said = sandboxCommand(findRoot(process4.cwd()), stateRoot, (process4.env.CLAUDE_PLUGIN_DATA ?? "") !== "");
      break;
    case "check-command":
      said = check2("command", more);
      break;
    case "check-path":
      said = check2("path", more);
      break;
    case "help":
    case "--help":
    case "-h":
      said = { code: OK, text: USE, json: { usage: USE } };
      break;
    default:
      said = { code: USAGE, text: USE, json: { error: "usage" } };
  }
  process4.stdout.write(`${isJson ? JSON.stringify(said.json, null, 2) : said.text}
`);
  if (isJson && said.warnings !== undefined && said.warnings.length > 0) {
    process4.stderr.write(`${said.warnings.join(`
`)}
`);
  }
  return said.code;
}
var code = main(process4.argv.slice(2));
if (typeof code === "number") {
  process4.exitCode = code;
} else {
  code.then((done) => {
    process4.exitCode = done;
  });
}
export {
  main
};
