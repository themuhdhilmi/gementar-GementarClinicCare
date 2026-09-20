import { Suspense } from 'react';
import { SetPasswordForm } from '@/components/set-password-form';

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm
        title="Choose a new password"
        description="This link works once, and only for the next 30 minutes."
        cta="Save new password"
      />
    </Suspense>
  );
}
