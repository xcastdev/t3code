import { EnvironmentHttpApi } from "@t3tools/contracts";
import {
  SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES,
  SELF_HOSTED_RELAY_HOOK_PROOF_HEADER,
} from "@t3tools/contracts/selfHostedRelayHooks";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Tracer from "effect/Tracer";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Metrics from "../observability/Metrics.ts";
import * as RelayDeliveryProof from "./RelayDeliveryProof.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

export const WEBHOOK_MAX_BODY_BYTES = SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES;

// The relay records this outcome header.
const WEBHOOK_OUTCOME_HEADER = "x-t3-hook-outcome";

const json = (
  status: number,
  body: Record<string, string>,
  outcome: string,
  headers?: Record<string, string>,
) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { ...headers, [WEBHOOK_OUTCOME_HEADER]: outcome },
  });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const relayDeliveryProof = yield* RelayDeliveryProof.RelayDeliveryProof;
    const handler = (selfHosted: boolean) =>
      Effect.fnUntraced(function* ({
        params,
        request,
      }: {
        readonly params: { readonly hookId: string; readonly token: string };
        readonly request: HttpServerRequest.HttpServerRequest;
      }) {
        // The router answers HEAD with the GET route; link checkers probe with HEAD.
        if (request.method === "HEAD") {
          return json(405, { error: "method_not_allowed" }, "method_not_allowed", {
            allow: "GET, POST, PUT, PATCH",
          });
        }
        const contentLength = Number(request.headers["content-length"] ?? "0");
        if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
          return json(413, { error: "body_too_large" }, "body_too_large");
        }
        // Chunked requests carry no content-length, so the reader itself is capped.
        const body = yield* request.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES),
          ),
          Effect.option,
        );
        const tooLarge = (error: string) =>
          Metrics.increment(Metrics.webhookDeliveriesTotal, {
            outcome: "body_too_large",
            source: selfHosted || request.headers["x-t3-relay-delivery-id"] ? "relay" : "direct",
          }).pipe(Effect.as(json(413, { error }, "body_too_large")));
        if (Option.isNone(body)) return yield* tooLarge("body_too_large_or_unreadable");
        if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
          return yield* tooLarge("body_too_large");
        }

        let headers: Readonly<Record<string, string>> = request.headers;
        const rawTarget = request.url;
        const queryIndex = rawTarget.indexOf("?");
        let relay: Option.Option<{
          readonly relayIssuer: string;
          readonly deliveryId: string;
          readonly receivedAt: string;
        }>;
        if (selfHosted) {
          const verified = yield* relayDeliveryProof
            .verifySelfHosted({
              headers,
              hookId: params.hookId,
              method: request.method,
              rawTarget,
              body: body.value,
            })
            .pipe(
              Effect.result,
              Effect.catchDefect(() => Effect.succeed(null)),
            );
          if (
            verified === null ||
            (Result.isFailure(verified) &&
              verified.failure._tag === "SelfHostedRelayHookVerificationUnavailable")
          ) {
            return json(500, { error: "internal_error" }, "error");
          }
          if (Result.isFailure(verified)) {
            return json(401, { error: "invalid_relay_proof" }, "invalid_relay_proof");
          }
          relay = Option.some(verified.success);
          headers = verified.success.headers;
        } else {
          relay = yield* relayDeliveryProof.verifyHosted({ headers, hookId: params.hookId });
          if (headers[SELF_HOSTED_RELAY_HOOK_PROOF_HEADER] !== undefined) {
            const { [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: _proof, ...directHeaders } = headers;
            headers = directHeaders;
          }
        }

        // Only the hosted relay supplies T3 Connect trace context.
        const relayParent =
          !selfHosted && Option.isSome(relay)
            ? HttpTraceContext.fromHeaders(request.headers)
            : Option.none<Tracer.ExternalSpan>();
        const result = yield* scheduledTasks
          .triggerWebhook({
            hookId: params.hookId,
            token: params.token,
            method: request.method,
            path: `${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(params.hookId)}`,
            query: queryIndex === -1 ? "" : rawTarget.slice(queryIndex + 1),
            headers,
            body: body.value,
            bodyText: new TextDecoder().decode(body.value),
            ...(selfHosted
              ? { relaySource: "self-hosted" as const }
              : Option.isSome(relay)
                ? { relaySource: "hosted" as const }
                : {}),
            ...(Option.isSome(relay)
              ? {
                  relayIssuer: relay.value.relayIssuer,
                  relayDeliveryId: relay.value.deliveryId,
                  receivedAt: relay.value.receivedAt,
                }
              : {}),
          })
          .pipe(
            Option.isSome(relayParent)
              ? (effect) =>
                  effect.pipe(Effect.withParentSpan(relayParent.value), withRelayClientTracing)
              : (effect) => effect,
            Effect.catchCause(() =>
              Effect.logWarning("Webhook delivery failed").pipe(
                Effect.as({ _tag: "error" as const }),
              ),
            ),
          );

        switch (result._tag) {
          case "accepted":
            return json(202, { deliveryId: result.deliveryId }, result.outcome);
          case "not_found":
            return json(404, { error: "hook_not_found" }, "not_found");
          case "rejected_signature":
            return json(401, { error: "invalid_signature" }, "rejected_signature");
          case "disabled":
            return json(409, { error: "hook_disabled" }, "disabled");
          case "blocked_by_policy":
            return json(403, { error: "blocked_by_policy" }, "blocked_by_policy");
          case "rate_limited":
            return json(429, { error: result.outcome }, result.outcome);
          case "expired":
            return json(410, { error: "delivery_too_old" }, "expired");
          case "error":
            return json(500, { error: "internal_error" }, "error");
        }
      });
    const direct = handler(false);
    const relay = handler(true);
    return handlers
      .handleRaw("webhookPost", direct)
      .handleRaw("webhookPut", direct)
      .handleRaw("webhookPatch", direct)
      .handleRaw("webhookGet", direct)
      .handleRaw("relayWebhookPost", relay)
      .handleRaw("relayWebhookPut", relay)
      .handleRaw("relayWebhookPatch", relay)
      .handleRaw("relayWebhookGet", relay);
  }),
);
