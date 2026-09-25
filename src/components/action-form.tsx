"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/(app)/actions";

/** Form wrapper that shows the success/error message returned by a server action. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { ok: false, message: null });
  return (
    <form
      action={formAction}
      className={className}
      key={resetOnSuccess && state.ok ? String(state.message) : undefined}
      aria-busy={pending}
    >
      {children}
      {state.message ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
            state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
