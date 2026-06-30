// Narrowing helpers for provider-error response bodies. Upstream providers
// non-uniformly shape their error JSON: OpenAI-format uses
// `{ error: { message } }`, NVIDIA NIM and others use a top-level
// `detail`/`message`/`errors[0].message`, Cohere returns
// `{ error: { message } }`, Cloudflare bundles an `errors[]` array, and so
// on. We harvest whatever we can find without surrendering the type to
// `any`. (#290)

interface UnknownError {
  error?: unknown;
  errors?: unknown;
  detail?: unknown;
  message?: unknown;
}

/** Type guard: the value is an object that *might* be a provider error body. */
function isUnknownErrorBody(value: unknown): value is UnknownError {
  return !!value && typeof value === "object";
}

/** Read `body.error.message`, `body.errors[0].message`, `body.detail`, or
 * `body.message` from an unknown response body. Returns undefined when
 * none of those paths is a string. Numbers/booleans/objects are skipped so
 * we never coerce a shape into a "message" by accident. */
export function extractErrorMessage(value: unknown): string | undefined {
  if (!isUnknownErrorBody(value)) return undefined;

  if (typeof value.error === "string") return value.error;
  if (
    isUnknownErrorBody(value.error) &&
    typeof value.error.message === "string"
  ) {
    return value.error.message;
  }

  if (Array.isArray(value.errors)) {
    for (const item of value.errors) {
      if (typeof item === "string") return item;
      if (isUnknownErrorBody(item) && typeof item.message === "string") {
        return item.message;
      }
    }
  }

  if (typeof value.detail === "string") return value.detail;
  if (typeof value.message === "string") return value.message;
  return undefined;
}
