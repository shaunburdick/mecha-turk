# Challenge ledger — specs/004-starting-prompt

## 2026-10-22 — Gate 3 (diff challenge), issue #69, commit 3cc0933 — DEFERRED

**FR-085's frame-head estimate is now knowingly stale and this amendment left it standing (deliberately, with rationale recorded in changelog.md v1.7.0 "Migration impact").** FR-085 (spec.md line 327) and Clarifications row 24 still state the automatic frame as ≈ 400 and the sums as 7,680 / 10,680; the shipped frame head measures ≈ 1,240 after v1.7.0's block (≈ 879 after v1.6.0 alone — the staleness predates #69). The load-bearing conclusion (composed message inside `CONTEXT_MAX_CHARS` 12,000 and `GUEST_ATTACH_TEXT_MAX` 16,000) is unchanged and still asserted; the fail-closed floor is untouched. The budget suite's FRAME_ALLOWANCE moved 400 → 1,300 and its statedSum 7,680 → 8,580 — the suite's "tighter limit" slack grew from ≈ 35 to ≈ 574 characters above the measured composed length (≈ 8,006); the two host caps still stand as the real bounds. Author's stated reason: test figure only, no product bound moved, FR-085's conclusion unchanged.

**How to verify/close**: at the next 004 amendment touching FR-085, re-cut the ≈ 400 estimate to the shipped head measure and re-derive the sums (7,680 → ≈ 8,006 default; 10,680 → ≈ 11,004 ceiling), or tighten FRAME_ALLOWANCE to measured head + small margin to restore the suite's teeth. Precedent: v1.4.2 corrected the same paragraph's 6,002 → 6,004 figures by amendment.

**Status of the rest of the #69 diff**: all five acceptance criteria DEFENDED; two cuts conceded and applied in 3f55d33 (the tautological assertion `expect(READ_SOURCE_BLOCK).toContain(READ_SOURCE_MECHANISM)`, and the once-only mechanism split on the benign golden frame — the hostile-fixture count stays) — non-blocking.
