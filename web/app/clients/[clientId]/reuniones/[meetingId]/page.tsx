import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { MeetingWorkspace } from "@/components/reuniones/MeetingWorkspace";
import { getMeeting } from "@/lib/meetingsData";
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
  await requireClientModulePage(clientId, "meetings");

  const meeting = await getMeeting(meetingId);
  if (!meeting) notFound();

  // The player's state comes from the MEETING, not from a prop someone remembers
  // to pass: a recording that failed has no audio to seek, and one that is still
  // uploading has none yet. This is what keeps the "audio no disponible" and
  // "cargando" states reachable instead of decorative.
  const audioState: AudioState =
    meeting.status.kind === "failed"
      ? "unavailable"
      : meeting.status.kind === "uploading"
        ? "loading"
        : "ready";

  return (
    <MeetingWorkspace meeting={meeting} backHref={`/clients/${clientId}/reuniones`} audioState={audioState} />
  );
}
