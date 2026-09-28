# Normalized Event Contract v1

> **Status (2026-09-27): carries forward to `specs/002-agent-event-extension`.** The normalized event shape, the four trigger kinds, source-identity scoping, and the untrusted-content rules are part of what survives the 001 → 002 split unchanged. 002 may version this schema; this file stays as the v1 record.

```json
{"schema_version":"1","provider":"github","account_id":"machine-user-id","repository":{"id":"123","owner":"example","name":"project"},"source":{"type":"issue_comment","id":"987","updated_at":"2026-09-26T12:00:00Z","url":"https://github.com/example/project/issues/1"},"kind":"mention","subject":{"type":"issue","number":1,"base_ref":null,"head_sha":null},"content":{"text":"<redacted-or-retained-by-policy>","author_id":"42","deleted":false},"correlation_id":"uuid"}
```

Kinds are `mention`, `issue_assignment`, `review_request`, and `review_assignment`. Source identity is scoped by provider/account/repository/type. Content is untrusted and delimited before dispatch. Comments are re-fetched; deleted/inaccessible content is non-actionable.
