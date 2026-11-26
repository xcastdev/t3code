import * as Schema from "effect/Schema";

export const RelayListenPort = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }));
