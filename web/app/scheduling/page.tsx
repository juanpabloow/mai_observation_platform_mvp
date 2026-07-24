import { redirect } from "next/navigation";

/** /scheduling → the agenda (the module's landing surface). */
export default function SchedulingIndex() {
  redirect("/scheduling/agenda");
}
