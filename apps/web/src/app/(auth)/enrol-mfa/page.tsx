"use client";

import { useRouter } from "next/navigation";
import { MfaEnrolment } from "@/components/mfa-enrolment";

export default function EnrolMfaPage() {
  const router = useRouter();
  return <MfaEnrolment forced onDone={() => router.replace("/workspace")} />;
}
