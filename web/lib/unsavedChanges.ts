/**
 * Which open forms have UNSAVED changes right now — so the session warning can say so before
 * the session ends («Tienes cambios sin guardar…»). Forms register through useLeaveGuard
 * (components/ui/useLeaveGuard.ts) with the same `dirty` flag they already compute. Nothing
 * is stored or recovered: this only lets us WARN honestly.
 */
const dirty = new Set<symbol>();

export function setUnsaved(key: symbol, isDirty: boolean): void {
  if (isDirty) dirty.add(key);
  else dirty.delete(key);
}

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}
