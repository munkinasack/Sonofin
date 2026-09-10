import { describe, expect, it, vi } from "vitest";

import { writeSmapiRequestLog, type SmapiLogSink } from "../src";

function createSink(): SmapiLogSink {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("writeSmapiRequestLog", () => {
  it("writes only the allow-listed request summary", () => {
    const sink = createSink();

    writeSmapiRequestLog(sink, {
      durationMs: 4,
      httpStatus: 200,
      outcome: "success",
      requestId: "request-1",
      soapMethod: "getLastUpdate",
    });

    expect(sink.info).toHaveBeenCalledOnce();
    expect(sink.info).toHaveBeenCalledWith(
      '{"event":"smapi.request","requestId":"request-1","httpStatus":200,"durationMs":4,"outcome":"success","soapMethod":"getLastUpdate"}',
    );
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });

  it("uses the warning channel for rejected requests", () => {
    const sink = createSink();

    writeSmapiRequestLog(sink, {
      durationMs: 2,
      httpStatus: 500,
      outcome: "rejected",
      reason: "invalid_soap",
      requestId: "request-2",
    });

    expect(sink.warn).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"invalid_soap"'),
    );
  });

  it("writes only fixed diagnostic classifications", () => {
    const sink = createSink();

    writeSmapiRequestLog(sink, {
      contentCategory: "album",
      contentKind: "category",
      durationMs: 3,
      httpStatus: 500,
      itemNotFoundOrigin: "jellyfin",
      outcome: "rejected",
      reason: "item_not_found",
      requestId: "request-3",
      soapMethod: "getMetadata",
    });

    expect(sink.warn).toHaveBeenCalledWith(
      '{"event":"smapi.request","requestId":"request-3","httpStatus":500,"durationMs":3,"outcome":"rejected","contentCategory":"album","contentKind":"category","itemNotFoundOrigin":"jellyfin","reason":"item_not_found","soapMethod":"getMetadata"}',
    );
  });
});
