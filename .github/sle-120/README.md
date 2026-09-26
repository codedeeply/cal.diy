# SLE-120: observability runbook

The instance has a single owner, Sierra. Bookers are third parties, so their data never goes to telemetry
(see `apps/web/lib/sentryPrivacy.ts`).

## What reports where

| Signal | Source | Sentry artifact |
| --- | --- | --- |
| Server, edge and browser errors | App SDK (`SENTRY_DSN`; browser DSN and release are build args) | Issue per error group |
| Uptime, database, booking page | `scripts/synthetic-checks.mjs`, run every 5 minutes by the host scheduler | Cron monitor `caldiy-synthetic`, plus a `Synthetic check failed: …` issue naming the failing checks |
| Checker stopped running | Sentry, when no check-in arrives within interval + margin | Monitor "missed" issue |

The free Sentry plan includes one cron monitor, so all three checks report through one check-in.
The check is read-only: a booking every 5 minutes would fill the owner's calendar and send email.
The full create-a-booking proof runs per release (`scripts/sle-122-booking-proof.sh`).

## Alerts

| Alert | Severity | Notify | Noise threshold |
| --- | --- | --- | --- |
| Monitor `caldiy-synthetic` failed or missed | High: bookers may be unable to book | Owner email (Sentry default issue alert) | 1 failed run opens the monitor issue, and 1 ok run resolves it (`failure_issue_threshold` and `recovery_threshold` = 1). A 5-minute interval plus 5-minute margin tolerates one slow run. The separate `Synthetic check failed: …` error issue, which names the failing checks, does **not** resolve on recovery. Resolve it after triage. |
| New error issue in `production` | Medium | Owner email, first occurrence only | Sentry groups repeats; a regression reopens a resolved issue |
| Error spike (>50 events/hour) | Medium | Owner email | Set in Sentry → Alerts; for one owner this is the only rate rule needed |

## Runbook

1. **`Synthetic check failed: database`**: the app is up but `/api/health` returns 503.
   - Check the Postgres container and disk.
   - Check the app's `DATABASE_URL`.
   - The issue resolves on the next ok run.
2. **`… uptime` or monitor missed**: the app or the host is down, or the scheduler stopped.
   - Check the container status and logs.
   - Check that the check timer is enabled.
3. **`… booking_page`**: the public booking page is broken while the app is up. This is usually a bad release.
   - Roll back to the previous signed image. See the SLE-121 rollback procedure.
4. **Phone numbers, notes, IP addresses or other personal data in an event** (anything beyond the booker's email and name on the event user, which the amended gate allows): treat it as a privacy incident.
   - Delete the event in Sentry.
   - Add a failing case to `sentryPrivacy.test.ts`, then fix the scrubber.

## Running the checks on a host

```sh
export BASE_URL="https://cal.example.com"
export CANARY_BOOKING_PATH="/owner/30min"   # your public booking page
export SENTRY_DSN="https://key@o0.ingest.us.sentry.io/0"   # your project DSN
export SENTRY_ENVIRONMENT="production"
node scripts/synthetic-checks.mjs
```

Run it every 5 minutes (systemd timer or cron). Exit codes:
- 0: all checks passed;
- 1: at least one check failed (reported to Sentry);
- 2: the checker itself could not run.

## Proofs

These use fake data and the non-production Sentry project only:
- `scripts/sle-120-sentry-proof.sh`: server, edge and browser errors, scrubbing, release and trace context.
- `scripts/sle-120-monitor-proof.sh`: ok, then error on a stopped database, then recovery.
