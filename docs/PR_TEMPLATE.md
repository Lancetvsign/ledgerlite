# Pull Request Template

Copy this into every pull request description. Sections are not optional — an empty
section means the question was not considered.

---

## Ticket

LL-XXX — Ticket Name

## Summary

What was implemented. Be specific about behavior, not just files touched.

## Why

The requirement this satisfies.

## Database Changes

- Schema changes:
- Migration filename(s):
- What the SQL actually does, in plain language:
- Constraints or triggers added:
- Backward compatible: Yes / No — if No, explain the expand → migrate → contract plan

## Environment Variables

Names only. **Never values.**

## Accounting Impact

`None`, or the specific accounting behavior introduced or changed. If this PR touches
posting, balancing, periods, reversal, or immutability, explain which invariant it
affects and which layer enforces it.

## Security Impact

Authentication, authorization, tenancy, or sensitive-data implications. `None` is a
valid answer, but only after checking.

## Tests Added

List each test and the invariant it proves.

## Test Results

| Check | Result |
|---|---|
| Lint | |
| TypeScript | |
| Unit | |
| Integration | |
| E2E | |
| Build | |

Report failures as failures.

## Vercel Preview

- Preview tested: Yes / No
- Neon preview branch verified: Yes / No
- **Production data present: must be NO**

## Manual Test Instructions

Concise steps for the reviewer.

## Known Limitations

## Rollback Considerations

Code rollback and migration rollback. If the migration is not reversible, say so and
explain what recovery looks like.

## Decisions Made That The Ticket Did Not Specify

Anything chosen rather than followed. This section is how an unplanned decision becomes
visible instead of buried.
