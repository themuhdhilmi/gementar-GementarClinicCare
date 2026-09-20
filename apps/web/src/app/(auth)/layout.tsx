export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-bold text-white">
            CC
          </span>
          <span className="text-lg font-semibold tracking-tight">ClinicCare</span>
        </div>
        {children}
      </div>
    </main>
  );
}
