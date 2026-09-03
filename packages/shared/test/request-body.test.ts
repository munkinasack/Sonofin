import { describe, expect, it } from "vitest";

import {
  InvalidUtf8BodyError,
  readUtf8Body,
  RequestBodyTooLargeError,
} from "../src";

describe("readUtf8Body", () => {
  it("reads a UTF-8 request body", async () => {
    const request = new Request("https://example.test", {
      body: "Sonofin 🎵",
      method: "POST",
    });

    await expect(readUtf8Body(request, 100)).resolves.toBe("Sonofin 🎵");
  });

  it("rejects an oversized declared content length before reading", async () => {
    const request = new Request("https://example.test", {
      body: "small",
      headers: { "content-length": "101" },
      method: "POST",
    });

    await expect(readUtf8Body(request, 100)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("stops a streamed body at the byte limit", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
      },
    });
    const request = new Request("https://example.test", {
      body: stream,
      duplex: "half",
      method: "POST",
    } as RequestInit & { duplex: "half" });

    await expect(readUtf8Body(request, 100)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(canceled).toBe(true);
  });

  it("rejects malformed UTF-8", async () => {
    const request = new Request("https://example.test", {
      body: new Uint8Array([0xc3, 0x28]),
      method: "POST",
    });

    await expect(readUtf8Body(request, 100)).rejects.toBeInstanceOf(
      InvalidUtf8BodyError,
    );
  });

  it("validates its byte limit", async () => {
    const request = new Request("https://example.test");

    await expect(readUtf8Body(request, -1)).rejects.toBeInstanceOf(RangeError);
  });
});
