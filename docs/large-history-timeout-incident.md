# Image-heavy history timed out before inference

A long-lived Codex task stopped producing events after viewing screenshots.
The Mac bridge returned 502 every two minutes, but the gateway had no
inference request record or active lease for the attempts.

The task's saved history was approximately 12.2 MB, including 21 inline
images. Its largest screenshot URL was approximately 2.6 MB. These exceeded
the previous 10 MiB request-body and 2 MiB generic-string bounds.

The failure was more than a small limit: data routes read a cloned request.
Cancelling an oversized cloned stream waits for its unread sibling, and
the bounded reader awaited that cancellation before throwing its error.
The request therefore hung instead of returning 413. The bridge's
two-minute response-header timeout turned the hang into a retryable 502.
The same cleanup problem could also defeat the body-read deadline.

The fix reads each authenticated data request once and starts cancellation
without awaiting an unbounded cleanup promise. Rejected bodies still stop
being read, and byte/deadline errors can reach clients promptly.

Transport limits are independent of model context-token accounting:

- Entire request: 32 MiB.
- Inline PNG/JPEG/GIF/WebP image URLs in typed input-image blocks: 8 MiB.
- Other strings: 2 MiB.
- Existing authentication order, nesting, node, item, deadline, and
  conservative inference accounting limits remain in force.

Tests exercise oversized cloned streams, stalled transport cancellation,
large screenshots versus oversized text, and authenticated 12 MiB/33 MiB
requests with no provider dispatch. Recovery uses the existing Codex task
and its intact history; no transcript editing or replacement task is needed.
