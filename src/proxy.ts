import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { GUEST_COOKIE_MAX_AGE_SECONDS, GUEST_ID_COOKIE } from "@/lib/guest";

/**
 * Refreshes the Supabase auth session on every request so server components
 * always see an up-to-date cookie-based session, and mints a guest session
 * id for unauthenticated visitors so they have a stable (if anonymous)
 * identity for chat/reactions without ever creating an account. Named
 * `proxy` per the Next.js 16 convention (formerly "Middleware").
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Touching the session refreshes expired tokens and rewrites the auth
  // cookies above via setAll. Do not remove even though the value is unused.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Only unauthenticated visitors get a guest id — an account holder's
  // identity is their profile, not a guest cookie. Minted here (not
  // lazily in a Server Action) so it exists before any guest-eligible
  // action needs it, and so it survives across the whole site, not just
  // the lobby.
  if (!user && !request.cookies.get(GUEST_ID_COOKIE)) {
    response.cookies.set(GUEST_ID_COOKIE, crypto.randomUUID(), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
      path: "/",
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
