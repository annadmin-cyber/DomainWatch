"use client";

import { useContext } from "react";
import { useFormStatus } from "react-dom";
import { ActionFormPending } from "@/components/action-form";

export function SubmitButton({
  children,
  pendingText = "Menyimpan…",
  className = "btn-primary",
  confirm,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  confirm?: string;
}) {
  const status = useFormStatus();
  const pending = useContext(ActionFormPending) || status.pending;
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </button>
  );
}
