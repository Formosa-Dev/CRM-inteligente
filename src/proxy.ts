import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  // Protect all /admin/* routes — the real login page is /login
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/admin/:path*"],
};
