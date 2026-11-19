import { createProductionDeps, handleRequest } from "../_shared/tracker-logic.mjs";

Deno.serve((req) => handleRequest(req, createProductionDeps({
  env: (name) => Deno.env.get(name) ?? "",
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
})));
