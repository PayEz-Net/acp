/**
 * Workspace Colonization — contract & types (colonization spec v2 §3/§4/§9).
 *
 * The renderer/project NEVER composes a path; colonization NEVER resolves
 * one — it consumes the single authority `resolveWorkDir` only. S1–S5 are
 * PRODUCTION-SHAPED injectable seams (real params with real defaults),
 * not test-only globals — spec §9 first-class deliverables.
 */

/** Project identity — NOT a path (spec §3). The installer-decided root flows
 *  in as `repo_path` via the single-authority chain (spec §5); colonization
 *  hands it to `resolveWorkDir`, never composes it. Consent is recorded by
 *  the installer's hard consent page (spec §2.3/§8.7). */
export interface ProjectIdentity {
  repo_path?: string | null;
  colonizationConsented: boolean;
  projectId?: string | number;
}

/**
 * Spec v2.1 (BAPert ruling): 'skipped' = deliberate non-destructive no-op,
 * nothing attempted, carries the durable notice, ZERO mutation; distinct
 * from 'rolled-back' (attempt occurred + reverted). Covers §4(1) no-root
 * and §8.7 no-consent.
 */
export type ColonizeStatus = 'colonized' | 'already-satisfied' | 'rolled-back' | 'skipped';

export interface ItemResult {
  id: string;
  outcome: 'already-satisfied' | 'materialized' | 'rolled-back' | 'skipped';
  error?: string;
}

export interface ColonizeResult {
  status: ColonizeStatus;
  root: string | null;
  items: ItemResult[];
  notice?: string;
}

export interface MaterializeCtx {
  /** Agent names threaded through colonization (used for markers/scaffold
   *  only; per-agent report command files are no longer generated). */
  agents: string[];
}

/**
 * A unit of "what colonization means" (spec §4 registry). Each item owns a
 * disjoint set of top-level entries it writes under its per-item stage dir;
 * the engine atomically swaps exactly those into the root and tracks them
 * for per-item this-run rollback. `check` is content/shape-aware so a prior
 * partial crash self-heals (idempotent, spec §2.4).
 */
export interface ColonizationItem {
  id: string;
  /** Content/shape-aware "already satisfied?" — receives ctx so per-agent
   *  artifacts (report files) are verified, not just dir existence. */
  check: (root: string, ctx: MaterializeCtx) => boolean;
  materialize: (itemStageDir: string, ctx: MaterializeCtx) => void;
  critical: boolean;
}

/**
 * S1–S5 seams (spec §9). Every field has a real production default; only
 * tests pass overrides. These are genuine params, never global test hacks.
 */
export interface ColonizeOptions {
  /** S1 — registry injection (AC5). Default: the production registry. */
  registry?: ColonizationItem[];
  /** S3 — resolveWorkDir injection (AC4). Default: real resolveWorkDir
   *  (lazily required so tests needn't load electron/pty). */
  resolveRoot?: (repoPath?: string | null) => string | null;
  /** S4 — deterministic stage-dir rundid. Default: time+random. */
  rundid?: string;
  /** S4 — lock wait budget (ms) for reproducible lockfile/concurrency
   *  assertions (spec §9 S4). Default: 10_000. */
  lockWaitMs?: number;
  /** S5 — notice sink. Default: the existing durable notice channel
   *  (<userData>/workdir-notices.log) — no 2nd surfacing path (spec §3/§9). */
  noticeSink?: (notice: string) => void;
  /** S2 — phase fault injection (AC3 atomicity). Default: none. */
  faultInject?: { phase: 'stage' | 'validate' | 'post-first-commit'; itemId?: string };
  /** Agent names threaded into MaterializeCtx (identity input). */
  agents?: string[];
  /** Per-file observation hook for the install-time readout. Called once
   *  per staged file just BEFORE the atomic commit swap: 'overwrite' if a
   *  file already exists at that path under root, else 'insert'. Purely
   *  observational — NEVER deletes, NEVER alters commit semantics, and is
   *  best-effort (a throw here can't break colonization). Default: none. */
  onFile?: (action: 'insert' | 'overwrite', name: string) => void;
}
