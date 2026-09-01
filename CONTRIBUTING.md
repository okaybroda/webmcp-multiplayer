# Contributing

Thanks for helping improve Canvas Relay.

- Keep the demos safe for a public shared room: do not add credentials, personal data, or private documents.
- Preserve the agent freshness model. Browser-visible WebMCP tools should not expose internal session IDs or let stale agents silently overwrite another participant's work.
- Run `npm run typecheck` and `npm run build` before opening a pull request.
- If you change `wrangler.jsonc`, run `npm run cf-typegen` and commit the resulting `worker-configuration.d.ts` update.

This is a demonstration project, not a production collaboration service. Authentication, authorization, and rate limiting are intentionally outside its current scope.
