export class RequestBodyTooLargeError extends Error {}

export class InvalidUtf8BodyError extends Error {}

function contentLengthExceedsLimit(
  value: string | null,
  maxBytes: number,
): boolean {
  if (value === null || !/^\d+$/.test(value)) {
    return false;
  }

  return BigInt(value) > BigInt(maxBytes);
}

/**
 * Reads a request body without ever buffering more than maxBytes. Invalid
 * UTF-8 is rejected instead of being silently replaced.
 */
export async function readUtf8Body(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  if (contentLengthExceedsLimit(request.headers.get("content-length"), maxBytes)) {
    throw new RequestBodyTooLargeError();
  }

  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  });
  let body = "";
  let byteLength = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort after the size limit is exceeded.
        }

        throw new RequestBodyTooLargeError();
      }

      body += decoder.decode(chunk.value, { stream: true });
    }

    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }

    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures while rejecting an invalid body.
    }

    throw new InvalidUtf8BodyError();
  } finally {
    reader.releaseLock();
  }
}
