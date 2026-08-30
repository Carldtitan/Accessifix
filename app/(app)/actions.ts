"use server";

import { signOut } from "@/auth";

/**
 * Sign out, then return to the landing page.
 *
 * A server action rather than a plain `<form action="/api/auth/signout">`:
 * Auth.js requires a CSRF token on that route, and a hand-rolled form has no
 * way to obtain one from a client component. Posting without it fails with
 * `MissingCSRF` and bounces the user to the sign-in page carrying an error -
 * which reads as "sign-in is broken" rather than "sign-out was rejected".
 *
 * `redirectTo: "/"` is deliberate. Signing out and landing on a page that
 * immediately asks you to sign in again is disorienting; the landing page is
 * where someone who has just left belongs.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
