import { describe, expect, it } from "vite-plus/test";

import { mediaResponse } from "./mediaResponse";

describe("hosted media responses", () => {
  it("requires an exact single partial range and relays only media headers", async () => {
    const make = (range: string) =>
      new Response("data", {
        status: 206,
        headers: {
          "Content-Type": "video/webm",
          "Content-Range": range,
          "Content-Length": "4",
          "Set-Cookie": "destination=value",
        },
      });

    const accepted = mediaResponse(make("bytes 8-11/20"), "GET", "bytes=8-11", "video");
    expect(accepted?.headers).toEqual({
      "accept-ranges": "bytes",
      "content-length": "4",
      "content-range": "bytes 8-11/20",
      "content-type": "video/webm",
    });
    expect(mediaResponse(make("bytes 7-10/20"), "GET", "bytes=8-11", "video")).toBeNull();
    expect(mediaResponse(make("bytes 8-11/20"), "GET", "bytes=8-11,15-17", "video")).toBeNull();
    expect(mediaResponse(make("bytes 8-11/20"), "GET", "bytes=8-11", "audio")).toBeNull();
    expect(await new Response(accepted?.body).text()).toBe("data");
  });

  it("allows a valid unsatisfiable range and rejects a short upstream stream", async () => {
    const refused = mediaResponse(
      new Response(null, { status: 416, headers: { "Content-Range": "bytes */20" } }),
      "GET",
      "bytes=20-",
      "video",
    );
    expect(refused).toEqual({
      status: 416,
      headers: { "content-range": "bytes */20", "accept-ranges": "bytes" },
      body: null,
    });

    const head = mediaResponse(
      new Response(null, {
        headers: { "Content-Type": "video/webm", "Content-Length": "20", "Accept-Ranges": "bytes" },
      }),
      "HEAD",
      "bytes=8-11",
      "video",
    );
    expect(head).toEqual({
      status: 200,
      headers: { "content-type": "video/webm", "content-length": "20", "accept-ranges": "bytes" },
      body: null,
    });

    const short = mediaResponse(
      new Response("data", {
        status: 206,
        headers: { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-7/8" },
      }),
      "GET",
      "bytes=0-",
      "audio",
    );
    await expect(new Response(short?.body).text()).rejects.toThrow();
  });
});
