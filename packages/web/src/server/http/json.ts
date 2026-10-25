import type { z } from 'zod';
import { API_RESPONSE_HEADERS, HttpError } from './errors.js';

const JSON_MEDIA_TYPE = 'application/json';

// JSON on the wire is UTF-8 (RFC 8259), so a body that names any other charset is refused
// rather than decoded as UTF-8 regardless.
function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const [mediaType, ...parameters] = header.split(';');
  if (mediaType?.trim().toLowerCase() !== JSON_MEDIA_TYPE) return false;
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=');
    if (equals === -1) return false;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const value = parameter.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    if (name === 'charset' && value !== 'utf-8') return false;
  }
  return true;
}

/**
 * A request's body as bytes, read only up to `maxBytes`. Content-Length is only a fast early
 * refusal; the count that decides is the bytes actually read, because the header can be absent
 * or lie, and reading stops as soon as the cap is passed. A request with no body is zero bytes.
 * Throws HttpError 400 body_too_large past the cap, and 400 bad_json for a body that fails to
 * arrive. Throws Error when `maxBytes` is not a positive integer, which is a server bug.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('the body cap must be a positive integer');
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) throw new HttpError(400, 'body_too_large');
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new HttpError(400, 'bad_json');
      });
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(400, 'body_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Reads a request's JSON body and checks it against a schema, failing closed at each step,
 * each with a fixed code and none repeating the body (C19):
 * - 400 bad_content_type unless Content-Type is application/json, with no charset other than UTF-8
 * - 400 body_too_large once more than `maxBytes` bytes arrive, whatever Content-Length says
 * - 400 bad_json for a body that cannot be read, is not UTF-8, or is not JSON
 * - 400 bad_body for JSON the schema refuses
 * Returns the schema's output, a fresh value the schema built. Throws Error when `maxBytes`
 * is not a positive integer, which is a server bug.
 */
export async function readJson<Schema extends z.ZodType>(request: Request, schema: Schema, maxBytes: number): Promise<z.output<Schema>> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('the body cap must be a positive integer');
  if (!isJsonContentType(request.headers.get('content-type'))) throw new HttpError(400, 'bad_content_type');
  const bytes = await readCappedBody(request, maxBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'bad_json');
  }
  const checked = schema.safeParse(parsed);
  // The issues are dropped on purpose: they quote the input.
  if (!checked.success) throw new HttpError(400, 'bad_body');
  return checked.data;
}

/**
 * A JSON response with API_RESPONSE_HEADERS. Every bigint is written as its decimal string,
 * so atomic amounts above 2^53 reach the browser exactly. Throws Error for a value JSON
 * cannot represent at all.
 */
export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString(10) : item));
  if (typeof body !== 'string') throw new Error('the response value has no JSON form');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [name, headerValue] of Object.entries(API_RESPONSE_HEADERS)) headers.set(name, headerValue);
  return new Response(body, { ...init, headers });
}
