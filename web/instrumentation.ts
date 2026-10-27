/**
 * Runs once when a Next.js server instance starts, before it serves requests. Next calls it in
 * every runtime, so Node-only work is imported ONLY inside the nodejs branch (the documented
 * pattern — anything else gets bundled for the edge runtime too).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
