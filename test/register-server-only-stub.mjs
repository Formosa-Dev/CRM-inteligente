// node:test runs server modules under the "default" export condition, where
// the `server-only` marker package throws at import time. The RSC bundler
// resolves it to the package's own empty.js via the "react-server" condition;
// this hook does the same thing surgically for the `server-only` specifier
// only, so other packages (e.g. react, which also has a react-server
// condition) resolve normally. A file URL is required — data: URLs crash
// the CJS load path under tsx.
import { registerHooks } from "node:module";

const EMPTY_URL = new URL(
  "../node_modules/server-only/empty.js",
  import.meta.url
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: EMPTY_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
