import { AccessHeading, AccessShell } from "@/components/access/AccessShell";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <AccessShell width={360}>
      <AccessHeading
        title="Recupera el acceso"
        lead="Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva. Al cambiarla se cierran todas tus sesiones."
      />
      <ForgotPasswordForm />
    </AccessShell>
  );
}
