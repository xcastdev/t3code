import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE scheduled_task_webhook_relay_receipts (
    relay_issuer TEXT NOT NULL,
    relay_delivery_id TEXT NOT NULL,
    hook_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    work_delivery_id TEXT,
    PRIMARY KEY (relay_issuer, relay_delivery_id)
  )`;
  yield* sql`CREATE INDEX idx_webhook_relay_receipt_expiry
    ON scheduled_task_webhook_relay_receipts(expires_at)`;

  yield* sql`ALTER TABLE scheduled_task_webhook_pending ADD COLUMN rendered_prompt TEXT`;
});
