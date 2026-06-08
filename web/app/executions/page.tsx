import { redirect } from "next/navigation";

/**
 * The executions list is now workflow-scoped at
 * /workflows/[workflowId]/executions. Redirect the old all-executions route to
 * the workflow picker so existing links don't dead-end.
 */
export default function ExecutionsRedirect() {
  redirect("/workflows");
}
