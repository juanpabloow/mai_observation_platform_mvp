import { Suspense } from "react";
import { AccessHeading, AccessShell } from "@/components/access/AccessShell";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";

export default function ResetPasswordPage() {
  return (
    <AccessShell width={360}>
      <AccessHeading title="Crea una contraseña nueva" lead="Al guardarla se cierran todas las sesiones abiertas de esta cuenta." />
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </AccessShell>
  );
}
