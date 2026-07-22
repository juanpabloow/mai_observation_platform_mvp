import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Recover access</h1>
        <p className="text-sm text-neutral-500">
          Enter your email and we&rsquo;ll send you a link to set a new password. Resetting signs
          out every existing session.
        </p>
      </div>
      <ForgotPasswordForm />
    </main>
  );
}
