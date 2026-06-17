import { redirect } from "next/navigation";

/**
 * The executions list is now nested at
 * /clients/[clientId]/workflows/[workflowId]/executions. Redirect the old
 * all-executions route to the Clients index so stale links don't dead-end.
 */
export default function ExecutionsRedirect() {
  redirect("/clients");
}
