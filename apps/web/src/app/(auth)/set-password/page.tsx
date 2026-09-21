import { Suspense } from "react";
import { SetPasswordForm } from "@/components/set-password-form";

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm
        title="Set your password"
        description="Welcome. Choose a password for your ClinicCare account."
        cta="Set password and continue"
      />
    </Suspense>
  );
}
