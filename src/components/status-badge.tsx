import type { RegistrationStatus } from "@/lib/monitor/transition";
import { STATUS_META } from "@/lib/status";

export function StatusBadge({ status }: { status: RegistrationStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <span
      title={meta.description}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

export function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}
