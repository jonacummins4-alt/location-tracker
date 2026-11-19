import { createReminderHandler } from "../_shared/reminder.mjs";

Deno.serve(createReminderHandler("amy", {
  env: (name) => Deno.env.get(name) ?? "",
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
}));
