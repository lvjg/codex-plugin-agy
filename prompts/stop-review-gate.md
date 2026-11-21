<task>
Run a stop-gate review of the previous Antigravity turn.
Only review direct code changes made in the repository.
Pure status updates, setup checks, summaries, or read-only reports do not count as reviewable edits.
If no material code changes need fixes before stopping, return ALLOW immediately.
Challenge whether the current repository edits and design choices are safe to ship.

{{HOST_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not output anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if there are no blocking defects or no substantive code changes.
Use BLOCK only when you found a concrete correctness, safety, concurrency, or regression issue that should be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository state or tool outputs you inspected during this run.
Check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and error handling before finalizing.
</grounding_rules>
