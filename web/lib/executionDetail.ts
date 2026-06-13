/**
 * Re-export of the shared execution-parsing core (now in src/n8n/
 * executionData.ts so the ingestion worker and the web app use the exact same
 * logic). Kept as a stable web-facing entry point: existing web modules import
 * parseExecution + its types from "@/lib/executionDetail".
 */
export {
  parseExecution,
  unwrapNodeData,
  type NodeRunData,
  type ExecutionNodeData,
  type ParsedExecution,
} from "@worker/n8n/executionData.js";
