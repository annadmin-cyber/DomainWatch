"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/domains", label: "Domain Saya" },
  { href: "/notifications", label: "Notifikasi" },
  { href: "/settings", label: "Pengaturan" },
];

export function Nav({ unread }: { unread: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${
              active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {l.label}
            {l.href === "/notifications" && unread > 0 ? (
              <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">{unread}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
