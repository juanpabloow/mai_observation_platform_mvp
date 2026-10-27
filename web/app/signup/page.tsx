import { isGoogleConfigured } from "@/lib/auth";
import { AccessShell } from "@/components/access/AccessShell";
import { SignupForm } from "@/components/access/SignupForm";

export default function SignupPage() {
  return (
    <AccessShell>
      <SignupForm googleEnabled={isGoogleConfigured} />
    </AccessShell>
  );
}
