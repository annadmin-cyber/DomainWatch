import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicSupabaseConfig } from "@/lib/env";

const PUBLIC_PATHS = ["/login", "/setup", "/auth"];

/**
 * Refreshes the Supabase session cookie on every request and redirects
 * signed-out visitors to /login. API routes do their own authorization
 * (cron secret or owner check) and are never redirected.
 */
export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cfg = publicSupabaseConfig();

  if (!cfg) {
    if (pathname.startsWith("/api") || pathname.startsWith("/setup")) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/setup";
    url.search = "";
    return NextResponse.redirect(url);
  }

  let response = NextResponse.next({ request });
  let signedIn = false;
  try {
    const supabase = createServerClient(cfg.url, cfg.key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    // Do not run code between createServerClient and getClaims().
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch (err) {
    // A Supabase outage or bad configuration must not crash every page:
    // continue as signed out. Pages and API routes verify access themselves.
    console.error("Session refresh failed:", err instanceof Error ? err.message : err);
  }

  if (pathname.startsWith("/api")) return response;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}
