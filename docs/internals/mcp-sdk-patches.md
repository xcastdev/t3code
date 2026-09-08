# MCP SDK protocol patches

T3 Code pins `@modelcontextprotocol/client` and `@modelcontextprotocol/server` to `2.0.0` with pnpm patches. Both packages bundle Protocol independently in ESM and CommonJS builds, so both patches change both builds.

## Cancellation of request ID zero

The upstream cancellation handler treats a falsy request ID as missing. Zero is a valid JSON-RPC ID and is the first server-initiated request ID. The patch checks for `undefined` instead. Without it, cancellation of the first forwarded roots, sampling, or elicitation request does not reach the downstream handler.

## Progress received immediately before a response

The SDK queues progress notification dispatch in a microtask but handles responses synchronously. If transport delivery includes progress followed by its response in one synchronous batch, the original response handler deletes the progress callback before the queued notification runs.

The patch queues progress-callback deletion in a microtask **before** invoking the response handler. Earlier progress runs before deletion. Progress received after the response runs after deletion and is ignored. Response-handler deletion and timeout cleanup remain synchronous. Cancellation and connection-close cleanup are unchanged.

## Regression coverage and removal condition

`apps/server/src/mcp/ProjectMcpSdk.test.ts` exercises the public transport interface against all four builds. A deterministic synchronous batch delivers progress, a success or error response, and more progress. Only the first progress callback is accepted. Other tests cover ID-zero cancellation and callback cleanup on cancellation and close.

`ProjectMcpProxyRegistry.stdio.test.ts` exercises real stdio upstreams and HTTP downstreams. Its first roots, sampling, and elicitation requests must receive cancellation before an explicit handler gate is released. The stdio fixture writes progress and completion together, without a ping between them. A single write does not guarantee a single read, which is why the synchronous public-transport regression is also required.

The focused reproduction command is:

```sh
vp test run apps/server/src/mcp/ProjectMcpSdk.test.ts apps/server/src/mcp/ProjectMcpProxyRegistry.stdio.test.ts
```

The patches are `patches/@modelcontextprotocol__client@2.0.0.patch` and `patches/@modelcontextprotocol__server@2.0.0.patch`. Exact-version entries in `pnpm-workspace.yaml` and hashes in `pnpm-lock.yaml` apply them during installation. A future SDK upgrade can remove the patches only when the unpatched replacement passes these regressions in both module formats.
