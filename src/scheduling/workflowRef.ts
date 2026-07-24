/**
 * Pure parser for the X-Workflow-Ref header value (n8n sends `{{$workflow.id}}`).
 * Trims whitespace; a missing/blank value → null (the HTTP layer maps that to the
 * 400 `workflow_ref_required`). Kept dependency-free so it is unit-testable
 * without importing the server-only auth module.
 */
export function parseWorkflowRef(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
