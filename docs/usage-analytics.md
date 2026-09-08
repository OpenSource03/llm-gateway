# Usage analytics

`GET /admin/v1/requests/usage` reports aggregate retained request metadata. It
requires `requests:read`; account display names/email labels additionally require
`accounts:read`. Without account access, labels fall back to opaque account IDs.
No additional storage, credentials, or provider calls are needed.

Parameters: `from`, `to` (ISO timestamps, inclusive start/exclusive end), `interval`
(`hour` or `day`), `provider`, `account_id`, `model` (exact public ID), and
`client_key_id`. Default: trailing seven days, daily buckets. Ranges are limited
to 90 days, or seven days for hourly buckets. Buckets are UTC and use request
start time; edge buckets can be partial. Missing buckets are zero-filled.

The response contains summary metrics, a chronological series, and the top 100
account/provider groups by accounted tokens. `accountCount` includes all groups,
including unassigned requests. All summary/chart totals cover the entire result,
not only the top accounts. Token values are decimal strings to retain integer
precision. Request history retention is 90 days; older ranges can be empty.

Ordinary input, cached input, and output are added once. Cached input includes
reads and cache creation, so it is not a cache-hit rate. Interrupted (`stream_error`)
and pending (`started`) token reservations are reported separately and excluded
from accounted totals. Unknown usage includes interrupted requests and rows with
missing input/output counts. Older rows can retain estimates even after success;
these analytics are not provider billing or account-wide subscription usage.
Traffic outside this gateway is not included. Success rate is successes divided
by completed requests, excluding pending requests. Average latency excludes
pending requests but includes both successful and failed completed requests.

The query aggregates in PostgreSQL inside a consistent read transaction with a
10-second statement deadline and 15-second transaction deadline. It never scans
history in the browser. The standalone admin client exposes `getUsage(filters)`.

Arcademy Admin consumes this endpoint through its existing authenticated BFF.
Its gateway landing page has an overview; `/llm-gateway/usage` provides detailed
filters and an account breakdown. Deployment requires both the gateway endpoint
and updated Admin code. Browser verification uses synthetic metadata, not live
provider requests.
