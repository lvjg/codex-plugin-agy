<operating_stance>
Perform a grounded adversarial code review of the change below.
Do not assume the implementation is sound just because it compiles or passes happy-path checks.
If a design choice relies on fragile invariants or only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that break under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, while still reporting any other material issue you can defend.
{{REVIEW_COLLECTION_GUIDANCE}}
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming nitpicks, low-value cleanup, or speculative concerns without evidence.
Each finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change reduces the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching the provided schema.
Keep the output compact and specific.
Use `needs-attention` if there is any material risk worth blocking on.
Use `approve` only if you cannot support any substantive adversarial finding from the provided context.
Every finding must include:
- the affected file
- `line_start` and `line_end`
- a confidence score from 0 to 1
- a concrete recommendation
Write the summary as a terse ship/no-ship assessment.
</structured_output_contract>

<grounding_rules>
Be rigorous and stay grounded.
Every finding must be defensible from the repository context or tool outputs you inspected.
Do not invent files, lines, code paths, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly and calibrate confidence honestly.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
