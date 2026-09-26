import type { Breadcrumb, Event } from "@sentry/nextjs";

// Telemetry leaves our process, so booking and identity data are removed here rather than
// relying on Sentry's server-side scrubbing. Names and notes have no recognisable shape, which
// is why fields are filtered by key and request bodies are dropped instead of pattern-matched.
const FILTERED = "[Filtered]";

const sensitiveKeyWords = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "email",
  "emails",
  "phone",
  "phonenumber",
  "sms",
  "note",
  "notes",
  "description",
  "response",
  "responses",
  "attendee",
  "attendees",
  "guest",
  "guests",
  "address",
  "location",
  "comment",
  "reason",
  "body",
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "cookies",
  "session",
  "credential",
  "credentials",
  "key",
  "otp",
  "ip",
  "query",
  "referer",
  "referrer",
  "title",
  "username",
  "organizer",
  "rescheduledby",
  "custominputs",
]);

// SDK-populated environment contexts (OS, runtime, browser, trace ids) describe the machine, not
// the booker; filtering their `name` fields would only hide useful diagnostics.
const sdkContexts = new Set([
  "app",
  "browser",
  "cloud_resource",
  "culture",
  "device",
  "os",
  "runtime",
  "trace",
]);
const urlKeys = ["url", "http.url", "url.full", "http.target", "to", "from"];
// Longer strings are truncated before matching so scrubbing cost stays bounded in the browser.
const maxScrubbedLength = 8192;

const safeHeaders = new Set(["accept", "content-type", "content-length", "host", "user-agent"]);

// Bounded quantifiers keep matching linear; `%40` catches URL-encoded addresses in API paths.
const emailPattern = /[\w.+-]{1,64}(?:@|%40)[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
// International or North American formats; ISO dates and ids are deliberately not matched.
const phonePattern = /\+\d[\d\s().-]{6,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
// Serialized fields in log and error messages: JSON (`"email":"x"`, `\"name\":\"x\"`) and the
// object-literal form Prisma uses in validation errors (`name: "x"`).
const fieldPatterns = [
  /(\\?"([A-Za-z_]+)\\?"\s*:\s*)(\\?")((?:\\\\|\\[^"\\]|[^"\\])*?)\3/g,
  /(\b([A-Za-z_]+)\s*:\s*)(")((?:\\.|[^"\\\n])*?)"/g,
];
// Unquoted numeric values such as `"phone":4155550142`, which the phone pattern alone misses.
const numericFieldPattern = /(\\?"?\b([A-Za-z_]+)\\?"?\s*:\s*)(\+?\d[\d\s().-]{3,}\d)/g;

function keyWords(key: string): string[] {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...words, words.join("")];
}

function isSensitiveKey(key: string): boolean {
  return keyWords(key).some((word) => sensitiveKeyWords.has(word));
}

function scrubString(value: string): string {
  // Field patterns are linear and run before truncation, so a value whose closing quote lies past
  // the cut-off is still filtered.
  let scrubbed = value;
  for (const pattern of fieldPatterns) {
    scrubbed = scrubbed.replace(pattern, (match, prefix: string, key: string, quote: string) =>
      isSensitiveKey(key) ? `${prefix}${quote}${FILTERED}${quote}` : match
    );
  }
  scrubbed = scrubbed.replace(numericFieldPattern, (match, prefix: string, key: string) =>
    isSensitiveKey(key) ? `${prefix}${FILTERED}` : match
  );
  if (scrubbed.length > maxScrubbedLength) {
    // Dropping the final partial token stops a cut-off email or number from escaping the patterns.
    scrubbed = `${scrubbed.slice(0, maxScrubbedLength).replace(/\S*$/, "")}…`;
  }
  return scrubbed.replace(emailPattern, FILTERED).replace(phonePattern, FILTERED);
}

function stripQuery(url: string): string {
  return url.replace(/[?#].*$/, "");
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  // Anything nested deeper than we inspect is withheld rather than sent unchecked.
  if (depth > 8) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? FILTERED : scrubValue(child, depth + 1);
  }
  return result;
}

function scrubRecord<T>(value: T): T {
  return scrubValue(value) as T;
}

// Scrubbing only replaces string values with strings, so the input's value types still hold.
function scrubUrlFields<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = scrubRecord(data);
  for (const [key, value] of Object.entries(result)) {
    // Next.js request paths (e.g. `request_path`) include booking-page prefill query strings.
    if (typeof value === "string" && (urlKeys.includes(key) || /path$/i.test(key))) {
      result[key] = stripQuery(value);
    }
  }
  return result as T;
}

/** Removes identity and booking data from error and transaction events before they are sent. */
function scrubEvent<T extends Event>(event: T): T {
  if (event.user) event.user = event.user.id === undefined ? undefined : { id: event.user.id };
  if (event.request) {
    const { url, method, headers } = event.request;
    event.request = {
      url: url ? stripQuery(url) : undefined,
      method,
      headers: headers
        ? Object.fromEntries(Object.entries(headers).filter(([name]) => safeHeaders.has(name.toLowerCase())))
        : undefined,
    };
  }
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry) {
    event.logentry = {
      message: event.logentry.message ? scrubString(event.logentry.message) : undefined,
      params: event.logentry.params ? scrubRecord(event.logentry.params) : undefined,
    };
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      // Local variables can hold request payloads.
      delete frame.vars;
    }
  }
  if (event.extra) event.extra = scrubRecord(event.extra);
  if (event.contexts) {
    event.contexts = Object.fromEntries(
      Object.entries(event.contexts).map(([name, context]) => [
        name,
        sdkContexts.has(name) || !context ? context : scrubUrlFields(context),
      ])
    );
  }
  // The root span's attributes (full URL, client IP, referer) are copied into the trace context.
  const traceData = event.contexts?.trace?.data;
  if (traceData && event.contexts?.trace) event.contexts.trace.data = scrubUrlFields(traceData);
  if (event.tags) event.tags = scrubRecord(event.tags);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((crumb) => {
      const scrubbed = scrubBreadcrumb(crumb);
      return scrubbed ? [scrubbed] : [];
    });
  }
  if (event.transaction) event.transaction = stripQuery(scrubString(event.transaction));
  if (event.spans) {
    for (const span of event.spans) {
      if (span.description) span.description = stripQuery(scrubString(span.description));
      if (span.data) span.data = scrubUrlFields(span.data);
    }
  }
  return event;
}

/** Console output can contain whole booking objects, so it never becomes a breadcrumb. */
function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  return {
    ...breadcrumb,
    message: breadcrumb.message ? scrubString(breadcrumb.message) : breadcrumb.message,
    data: breadcrumb.data ? scrubUrlFields(breadcrumb.data) : breadcrumb.data,
  };
}

export { scrubBreadcrumb, scrubEvent };
