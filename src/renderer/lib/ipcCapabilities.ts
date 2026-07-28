/**
 * Feature detection for optional main-process IPC methods (WO 11620,
 * renderer↔main mixed-state).
 *
 * Vite HMR can hot-swap the renderer ahead of the main process: the UI then
 * carries code for IPC the running main does not implement (the purge-queue /
 * steer incident — a new banner promising behavior the old main could not
 * deliver). Every optional capability is probed at the call site so the UI
 * degrades honestly instead of silently promising more than main can do.
 * HMR re-evaluates this module on swap, so detection tracks the live surface.
 */
export function hasIpcMethod(name: string): boolean {
  const api = (window as { electronAPI?: Record<string, unknown> }).electronAPI;
  return typeof api?.[name] === 'function';
}
