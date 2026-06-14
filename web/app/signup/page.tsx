import { Suspense } from "react";
import { isGoogleConfigured } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";

export default function SignupPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
        <p className="text-sm text-neutral-500">Sign up with email and password.</p>
      </div>
      <Suspense fallback={null}>
        <AuthForm mode="signup" googleEnabled={isGoogleConfigured} />
      </Suspense>
    </main>
  );
}
