/** The ONE answer for every unavailable booking page (unknown slug, inactive site,
 * default client, scheduling disabled, kill switch) — identical, so nothing is learnt
 * from which one it was. */
export default function BookingNotFound() {
  return (
    <main lang="es" className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-2 px-5 py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Esta página de reservas no está disponible</h1>
      <p className="text-sm text-muted">Revisa el enlace o comunícate directamente con el negocio.</p>
    </main>
  );
}
