import type { Breadcrumb, Event } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent } from "./sentryPrivacy";

// Synthetic booker data; every value must be absent from anything sent to Sentry.
const prohibited = {
  name: "Quinn Synthetic-Booker",
  email: "quinn.booker@example.invalid",
  phone: "+1 415 555 0142",
  localPhone: "(415) 555-0199",
  notes: "Please bring the synthetic contract",
  ip: "203.0.113.7",
  token: "synthetic-session-token-value",
  cookie: "next-auth.session-token=synthetic-cookie-value",
  location: "Synthetic Street 1",
};

function expectNoProhibitedData(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const [field, secret] of Object.entries(prohibited)) {
    expect(serialized, `${field} leaked`).not.toContain(secret);
  }
}

function errorEvent(): Event {
  return {
    message: `Booking failed for ${prohibited.email}`,
    user: { id: 42, email: prohibited.email, username: prohibited.name, ip_address: prohibited.ip },
    request: {
      url: `https://cal.example.invalid/team/demo?email=${prohibited.email}&name=Quinn`,
      method: "POST",
      data: { name: prohibited.name, notes: prohibited.notes },
      query_string: `email=${prohibited.email}`,
      cookies: { "next-auth.session-token": prohibited.token },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${prohibited.token}`,
        Cookie: prohibited.cookie,
        "X-Forwarded-For": prohibited.ip,
      },
    },
    exception: {
      values: [
        {
          type: "HttpError",
          // Shape observed in Cal's EventManager failure log during the SLE-122 proof.
          value: `EventManager.create failure {\\"attendees\\":[{\\"email\\":\\"${prohibited.email}\\",\\"name\\":\\"${prohibited.name}\\"}],\\"additionalNotes\\":\\"${prohibited.notes}\\",\\"eventTypeId\\":1}`,
          stacktrace: {
            frames: [
              {
                filename: "app:///handleNewBooking.ts",
                function: "create",
                vars: { booker: prohibited.name },
              },
            ],
          },
        },
      ],
    },
    extra: { booking: { responses: { name: prohibited.name, location: prohibited.location } }, bookingId: 7 },
    contexts: {
      os: { name: "Linux" },
      runtime: { name: "node", version: "v24.21.0" },
      booking: { attendeePhoneNumber: prohibited.phone, smsReminderNumber: prohibited.localPhone },
    },
    tags: { errorSource: "server", attendee: prohibited.email },
    breadcrumbs: [
      { category: "console", message: `Created booking for ${prohibited.name}` },
      {
        category: "fetch",
        data: { url: `https://api.example.invalid/x?phone=${prohibited.phone}`, method: "GET" },
      },
    ],
  };
}

describe("scrubEvent", () => {
  it("removes identity, booking, auth and network data from error events", () => {
    const { user, ...rest } = scrubEvent(errorEvent());
    expectNoProhibitedData(rest);
    expect(JSON.stringify(user)).not.toContain(prohibited.ip);
  });

  it("keeps the diagnostics needed to act on an error", () => {
    const event = scrubEvent(errorEvent());
    // Owner decision (SLE-120): the booker's email and name identify the affected user.
    expect(event.user).toEqual({ id: 42, email: prohibited.email, username: prohibited.name });
    expect(event.request).toEqual({
      url: "https://cal.example.invalid/team/demo",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(event.exception?.values?.[0].type).toBe("HttpError");
    expect(event.exception?.values?.[0].value).toContain('\\"eventTypeId\\":1');
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0]).toEqual({
      filename: "app:///handleNewBooking.ts",
      function: "create",
    });
    expect(event.contexts?.os).toEqual({ name: "Linux" });
    expect(event.contexts?.runtime).toEqual({ name: "node", version: "v24.21.0" });
    expect(event.extra?.bookingId).toBe(7);
    expect(event.tags?.errorSource).toBe("server");
    expect(event.breadcrumbs).toEqual([
      { category: "fetch", data: { url: "https://api.example.invalid/x", method: "GET" } },
    ]);
  });

  it("removes query strings and personal data from transaction spans", () => {
    const transaction: Event = {
      type: "transaction",
      transaction: `GET /booking?email=${prohibited.email}`,
      spans: [
        {
          span_id: "1",
          trace_id: "2",
          start_timestamp: 0,
          description: `POST /api/book/event?name=${prohibited.name}`,
          data: {
            "url.full": `https://cal.example.invalid/api/book/event?phone=${prohibited.phone}`,
            "url.query": `name=${prohibited.name}`,
            "http.request.method": "POST",
          },
        },
      ],
    };
    const scrubbed = scrubEvent(transaction);
    expectNoProhibitedData(scrubbed);
    expect(scrubbed.transaction).toBe("GET /booking");
    expect(scrubbed.spans?.[0].data?.["http.request.method"]).toBe("POST");
  });

  it("does not mistake dates or identifiers for phone numbers", () => {
    const event = scrubEvent({ message: "Slot 2026-10-01T09:00:00Z for event type 1234567 failed" });
    expect(event.message).toBe("Slot 2026-10-01T09:00:00Z for event type 1234567 failed");
  });
});

describe("scrubEvent privacy review regressions", () => {
  it("scrubs root-span attributes copied into the trace context", () => {
    const event = scrubEvent({
      type: "transaction",
      contexts: {
        trace: {
          trace_id: "t",
          span_id: "s",
          data: {
            "http.url": `https://cal.example.invalid/book?email=${prohibited.email}`,
            "http.target": `/book?name=${prohibited.name}`,
            "http.client_ip": prohibited.ip,
            "http.request.header.x_real_ip": prohibited.ip,
            "http.request.header.referer": `https://cal.example.invalid/x?notes=${prohibited.notes}`,
            "http.method": "GET",
          },
        },
      },
    });
    expectNoProhibitedData(event);
    expect(event.contexts?.trace?.trace_id).toBe("t");
    expect(event.contexts?.trace?.data?.["http.target"]).toBe("/book");
    expect(event.contexts?.trace?.data?.["http.method"]).toBe("GET");
  });

  it("filters booking values in Prisma object-literal validation errors", () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            type: "PrismaClientValidationError",
            value: `Invalid prisma.booking.create() invocation: { data: { title: "30 min between Host and ${prohibited.name}", description: "${prohibited.notes}", eventTypeId: 1 } }`,
          },
        ],
      },
    });
    expectNoProhibitedData(event);
    expect(event.exception?.values?.[0].value).toContain("eventTypeId: 1");
  });

  it("strips query strings from Next.js request paths", () => {
    const event = scrubEvent({
      contexts: { nextjs: { request_path: `/team/demo?name=${prohibited.name}`, router_kind: "App Router" } },
    });
    expectNoProhibitedData(event);
    expect(event.contexts?.nextjs).toEqual({ request_path: "/team/demo", router_kind: "App Router" });
  });

  it("masks URL-encoded email addresses in span descriptions", () => {
    const encoded = encodeURIComponent(prohibited.email);
    const event = scrubEvent({
      type: "transaction",
      spans: [
        {
          span_id: "1",
          trace_id: "2",
          start_timestamp: 0,
          data: {},
          description: `GET /calendars/${encoded}/events`,
        },
      ],
    });
    expect(JSON.stringify(event)).not.toContain(encoded);
  });

  it("scrubs very long messages in bounded time", () => {
    const started = performance.now();
    const event = scrubEvent({ message: `${"a".repeat(200_000)} ${prohibited.email}` });
    expect(performance.now() - started).toBeLessThan(500);
    expect(event.message?.length).toBeLessThanOrEqual(8193);
  });
});

describe("scrubEvent CodeRabbit regressions", () => {
  it("filters a quoted field whose closing quote lies past the truncation point", () => {
    const event = scrubEvent({ message: `${"x".repeat(8180)} {"name":"${prohibited.name}"}` });
    expectNoProhibitedData(event);
  });

  it("filters unquoted numeric values under sensitive keys", () => {
    const event = scrubEvent({ message: '{"phone":4155550142,"eventTypeId":12}' });
    expect(event.message).not.toContain("4155550142");
    expect(event.message).toContain('"eventTypeId":12');
  });

  it("withholds objects nested deeper than the scrubber inspects", () => {
    let nested: Record<string, unknown> = { email: prohibited.email, name: prohibited.name };
    for (let level = 0; level < 12; level++) nested = { level: nested };
    const event = scrubEvent({ extra: { nested } });
    expectNoProhibitedData(event);
    const crumb = scrubBreadcrumb({ category: "fetch", data: { nested } });
    expectNoProhibitedData(crumb);
  });
});

describe("scrubEvent second CodeRabbit regressions", () => {
  it("filters quoted fields with dotted names", () => {
    const event = scrubEvent({ message: `{"attendee.name":"${prohibited.name}","eventType.id":3}` });
    expectNoProhibitedData(event);
    expect(event.message).toContain('"eventType.id":3');
  });

  it("strips query strings from URLs embedded in free text", () => {
    const event = scrubEvent({
      message: `Redirect to https://cal.example.invalid/team/demo?name=Quinn+Synthetic-Booker failed`,
      breadcrumbs: [{ category: "navigation", message: "to /booking/abc?name=Quinn+Synthetic-Booker" }],
    });
    expect(JSON.stringify(event)).not.toContain("Quinn");
    expect(event.message).toBe("Redirect to https://cal.example.invalid/team/demo failed");
  });

  it("scrubs the values of allowed request headers", () => {
    const event = scrubEvent({
      request: { headers: { "User-Agent": `Mozilla/5.0 ${prohibited.email}`, Accept: "text/html" } },
    });
    expectNoProhibitedData(event);
    expect(event.request?.headers?.Accept).toBe("text/html");
  });
});

describe("scrubEvent booker identity", () => {
  it("keeps only email and name on the user, and drops the IP and other fields", () => {
    const event = scrubEvent({
      user: {
        email: prohibited.email,
        username: prohibited.name,
        ip_address: prohibited.ip,
        geo: { city: "X" },
      },
    });
    expect(event.user).toEqual({ email: prohibited.email, username: prohibited.name });
  });

  it("omits the user entirely when nothing identifying remains", () => {
    expect(scrubEvent({ user: { ip_address: prohibited.ip } }).user).toBeUndefined();
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console breadcrumbs and scrubs the rest", () => {
    expect(scrubBreadcrumb({ category: "console", message: prohibited.name })).toBeNull();
    const crumb: Breadcrumb = {
      category: "navigation",
      message: `to /reschedule?email=${prohibited.email}`,
      data: { from: "/a?x=1", to: `/b?name=${prohibited.name}` },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expectNoProhibitedData(scrubbed);
    expect(scrubbed?.data).toEqual({ from: "/a", to: "/b" });
  });
});
