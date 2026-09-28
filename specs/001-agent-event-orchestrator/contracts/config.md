# Configuration Contract v1 (deferred daemon path)

> **Status (2026-09-27): retained evidence, not the production config.** `specs/002-agent-event-extension` owns production configuration (extension integration settings + panel storage + service settings). Structural note only: the `polling.page_size: 100` below assumes a transport that talks to GitHub directly; any leg crossing the guest request cap is limited to `per_page ≤ 30` (`research.md` §a.5). Recorded here so the difference is visible rather than silently reconciled.

This contract is not used by the first extension spike. The spike uses the OpenChamber extension manifest and Settings → Integrations; this YAML applies only if a later phase approves the standalone daemon.

YAML is strict. Secrets use `{env: NAME}` or `{file: /run/secrets/name}` and are never persisted.

```yaml
github:
  api_base_url: https://api.github.com
  api_version: "2022-11-28"
  pat: {file: /run/secrets/github-pat}
  expected_login: null
repositories:
  - owner: example
    name: project
    repository_id: "123456"
    triggers: [mentions, issue_assignments, review_requests, review_assignments]
    project_ref: project-id
    workflow_ref: project-manager
openchamber:
  endpoint: https://openchamber.example:4096
  auth: {file: /run/secrets/openchamber-token}
  adapter_version: "1"
  required_capabilities: [health, dispatch_work, dispatch_review]
policy:
  autonomous_dispatch: true
  approval_gates: []
  forbidden_actions: [merge, deploy, repository_admin]
polling: {interval: 60s, overlap: 10m, page_size: 100, max_concurrency: 2}
storage: {database: /var/lib/mecha-turk/mecha-turk.sqlite, detailed_retention: 720h, audit_retention: 8760h}
operations: {health_bind: "", queue_limit: 100, shutdown_grace: 30s}
```

Validation identifies fields/remediation, never values. Authenticated login comes from GitHub `/user`.
