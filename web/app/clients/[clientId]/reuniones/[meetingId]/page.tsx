import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { MeetingWorkspace } from "@/components/reuniones/MeetingWorkspace";
import { MeetingDeletionProvider } from "@/components/reuniones/MeetingDeletion";
import { getMeeting, getMeetingAudioAvailability } from "@/lib/meetingsData";
import type { AudioState } from "@/components/reuniones/AudioPlayer";

/**
 * A single meeting: transcript, summary, reports and cited evidence.
 *
 * Same gate as the listing — an unknown meeting is a 404, indistinguishable from
 * a foreign one, so probing ids reveals nothing.
 *
 * The workspace itself is a Client Component because the tab, the two optional
 * panels and the playhead are ONE piece of state (an evidence chip switches the
 * view AND moves the audio AND highlights a segment). The DATA is still resolved
 * here on the server and handed down as a prop.
 */
export default async function MeetingPage({
  params,
}: {
  params: Promise<{ clientId: string; meetingId: string }>;
}) {
  await connection();
  const { clientId, meetingId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "meetings");

  const meeting = await getMeeting({ tenantId: scope.tenantId, clientId: client.id }, meetingId);
  if (!meeting) notFound();

  // El estado del reproductor sale de la REUNIÓN, no de una prop que alguien
  // recuerde pasar: una grabación fallida no tiene nada que buscar, y una que
  // sigue subiendo todavía no. Eso es lo que mantiene alcanzables los estados
  // "audio no disponible" y "cargando" en vez de decorativos.
  //
  // Y hay una tercera razón para no estar disponible que el estado del pipeline
  // no captura: que el `normalized` no exista o lo haya borrado la retención.
  // Por eso se consulta si hay audio reproducible de verdad, en vez de deducirlo.
  const playable = await getMeetingAudioAvailability(
    { tenantId: scope.tenantId, clientId: client.id },
    meetingId,
  );
  const audioState: AudioState =
    meeting.status.kind === "failed" || !playable
      ? "unavailable"
      : meeting.status.kind === "uploading"
        ? "loading"
        : "ready";

  return (
    // El mismo proveedor que el listado, con el mismo diálogo dentro.
    <MeetingDeletionProvider
      clientId={client.id}
      canDelete={scope.role === "owner" || scope.role === "admin"}
    >
    <MeetingWorkspace
      meeting={meeting}
      clientId={client.id}
      backHref={`/clients/${clientId}/reuniones`}
      audioState={audioState}
      // La URL firmada NO se resuelve en el servidor y se manda al cliente: se
      // pide desde el navegador cuando el usuario le da a reproducir, y así
      // caduca contando desde ese momento y no desde que se pintó la página.
      audioSrc={playable ? `/api/meetings/v1/meetings/${meetingId}/media?clientId=${client.id}` : null}
    />
    </MeetingDeletionProvider>
  );
}
