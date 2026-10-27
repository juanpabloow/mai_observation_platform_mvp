import { getServerSession } from "@/lib/session";
import { canViewUserAvatar, getUserAvatar } from "@worker/db/repositories/userProfiles.js";

/**
 * GET /api/account/avatar/{userId} — a person's uploaded photo. PRIVATE: only the person and
 * the people of their own tenant (the team) get it; anyone else — another tenant, no session
 * — gets the same 404, so the route says nothing about who exists. Never publicly cached.
 * The bytes were validated by magic number on upload; they are served with their stored
 * type and `nosniff`, so the browser can never reinterpret them.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  const { userId } = await params;
  const session = await getServerSession();
  const viewer = session?.user?.id;
  const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  if (!viewer || !userId || !(await canViewUserAvatar(viewer, userId))) return notFound();
  const avatar = await getUserAvatar(userId);
  if (!avatar) return notFound();
  const etag = `"${avatar.sha256}"`;
  const common = {
    "Cache-Control": "private, max-age=300",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: common });
  return new Response(new Uint8Array(avatar.bytes), { headers: { ...common, "Content-Type": avatar.content_type } });
}
