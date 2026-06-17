import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getEndpoints, type RendererEndpoints } from '../../services/endpoints';

/**
 * Read-only environment indicator (WO #292 / Aurum visual spec 6028).
 *
 * Prominence scales with CONFUSION-RISK, not env name — the danger is a DEV
 * build acting on PROD (live data, sandbox mindset), NOT "being in prod":
 *   - packaged prod (end user)    → NO chrome (prod is normal; no alarm-fatigue)
 *   - packaged non-prod (dist:93) → LOUD "INTERNAL DEV BUILD" (must never pass as public)
 *   - dev source → dev93          → quiet "DEV · 93" (safe sandbox)
 *   - dev source → PROD (danger)  → LOUD "DEV → PROD · LIVE DATA" (amber + red ring)
 *   - dev source → other/staging  → distinct color, still labeled
 *
 * Dual-encoded (color AND text — colorblind-safe), persistent, read-only.
 * This is a status light, NOT a switch (env is build/launch-time only).
 */
export function EnvIndicator() {
  const [env, setEnv] = useState<RendererEndpoints | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEndpoints()
      .then((e) => { if (!cancelled) setEnv(e); })
      .catch(() => { /* indicator is best-effort; never blocks the UI */ });
    return () => { cancelled = true; };
  }, []);

  // Resolving — show nothing rather than a placeholder that could read as a wrong env.
  if (!env) return null;

  const { envName, isPackaged, isInternalDevBuild } = env;

  // packaged prod = the product itself; no env chrome.
  if (isPackaged && envName === 'prod') return null;

  const base = 'select-none flex items-center gap-1 px-2 py-0.5 rounded text-[11px] tracking-wide whitespace-nowrap';

  // A packaged non-prod (dist:93) build must be unmistakable — never the public installer.
  if (isInternalDevBuild) {
    return (
      <span title={`Internal dev build — packaged installer baked ACP_ENV=${envName} (not prod). NOT for public release.`}
            className={`${base} font-semibold bg-red-600 text-white`}>
        <AlertTriangle className="h-3 w-3 shrink-0" /> INTERNAL DEV BUILD
      </span>
    );
  }

  // dev-from-source → PROD: the load-bearing danger (dev mindset, live data).
  if (envName === 'prod') {
    return (
      <span title="You are running a DEV build pointed at PRODUCTION — actions hit LIVE data."
            className={`${base} font-bold bg-amber-500 text-black ring-1 ring-red-600`}>
        <AlertTriangle className="h-3 w-3 shrink-0" /> DEV → PROD · LIVE DATA
      </span>
    );
  }

  // dev-from-source → dev93: quiet, present.
  if (envName === 'dev93') {
    return (
      <span title="Dev build pointed at the dev-93 sandbox."
            className={`${base} font-medium bg-slate-600 text-slate-100`}>
        DEV · 93
      </span>
    );
  }

  // Future envs (e.g. staging) — distinct color, still labeled.
  return (
    <span title={`Dev build pointed at ${envName}.`}
          className={`${base} font-medium bg-violet-600 text-white`}>
      DEV · {envName.toUpperCase()}
    </span>
  );
}
