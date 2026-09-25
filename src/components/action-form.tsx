"use client";

import { createContext, startTransition, useActionState } from "react";
import type { ActionState } from "@/app/(app)/actions";

/** Pending state for SubmitButton inside an ActionForm (useFormStatus does not see it). */
export const ActionFormPending = createContext(false);

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
      // React resets a form after every function action, even when it returns an
      // error. Submitting through startTransition keeps what the user typed; the
      // key below still clears the form after a success when asked to.
      // (Without JavaScript the plain `action` above is used.)
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className={className}
      key={resetOnSuccess && state.ok ? String(state.message) : undefined}
      aria-busy={pending}
    >
      <ActionFormPending value={pending}>{children}</ActionFormPending>
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
