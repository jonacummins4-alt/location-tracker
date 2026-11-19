import { retiredPasswordHint } from "../_shared/tracker-logic.mjs";

// Replaces the deployed function that emailed the tracker password to whatever
// address was stored in user_settings. It no longer reads the database or sends mail.
Deno.serve((req) => {
  if (req.method === "OPTIONS") return retiredPasswordHint();
  return retiredPasswordHint();
});
