/**
 * Invitation copy shared by the email (lib/inviteActions.ts) and the accept page — pure.
 * Everything shown comes from the SERVER's invitation row (business, access, inviter); the
 * person never chooses or edits any of it.
 */
import { SYSTEM_ROLE_LABEL } from "./permissions/catalog";

export const INVITE_TTL_DAYS = 7;

export interface InviteFacts {
  role: "admin" | "member";
  client_role: string | null;
  access_role_name: string | null;
  client_name: string | null;
  tenant_name: string;
  invited_by_name?: string | null;
  invited_by_email?: string | null;
}

/** The business the person joins: the client for a business role, the agency otherwise. */
export function inviteBusinessName(i: InviteFacts): string {
  return (i.role === "member" ? i.client_name : null) ?? i.tenant_name;
}

/** "Recepción", "Dueño", a custom role's name… — the access the server assigned. */
export function inviteAccessLabel(i: InviteFacts): string {
  if (i.role !== "member") return "Administración de la agencia";
  if (i.client_role === "custom") return i.access_role_name ?? "Rol personalizado";
  if (i.client_role === "owner" || i.client_role === "setter" || i.client_role === "staff") {
    return SYSTEM_ROLE_LABEL[i.client_role];
  }
  return "Miembro";
}

/** "Laura Gómez" — or their email when they never set a name; null when unknown. */
export function inviterLabel(i: InviteFacts): string | null {
  const name = i.invited_by_name?.trim();
  if (name && name !== i.invited_by_email?.split("@")[0]) return name;
  return i.invited_by_email ?? name ?? null;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The invitation email (2a/2d): inline styles only, no tracking, no remote images. */
export function inviteEmailHtml(p: { inviter: string; business: string; access: string; email: string; acceptUrl: string }): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#F4F4F5;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:536px;background:#fff;border-radius:12px;padding:36px 32px 28px">
      <tr><td>
        <p style="margin:0 0 20px;font-size:14px;font-weight:600;letter-spacing:.02em">MONTSERRAT<span style="color:#E5484D">_</span>AI</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.02em">${esc(p.inviter)} te invitó a ${esc(p.business)}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#3A3D42">Tendrás acceso como <b style="font-weight:600;color:#111">${esc(p.access)}</b>. Crea tu perfil para empezar.</p>
        <a href="${esc(p.acceptUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px">Aceptar invitación</a>
        <p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#6E6E73">El enlace vence en ${INVITE_TTL_DAYS} días y solo funciona para ${esc(p.email)}. Si no esperabas esta invitación, ignora este correo.</p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#80808A">Montserrat AI</p>
  </td></tr></table>
</body></html>`;
}
