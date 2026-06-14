import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/**
 * Mounts Better Auth's request handler at /api/auth/* (sign-up, sign-in,
 * sign-out, OAuth callbacks, session, …). The client SDK (web/lib/auth-client)
 * talks to these endpoints.
 */
export const { GET, POST } = toNextJsHandler(auth);
