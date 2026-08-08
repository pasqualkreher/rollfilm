<!--
Thanks for sending this. A one-person project reviews slowly — a filled-in
description is what makes it fast. Delete any section that doesn't apply.
-->

## What changes for the user

<!--
One or two sentences, in terms of what someone using Rollfilm would notice.
"Dragging the scrubber to a date now lands there instead of a month off."
Not "refactored TimelineScrubber.measure()".

If nothing changes for the user (a refactor, a test, docs), say that.
-->

## Why

<!--
What was wrong, and why it was wrong. If this fixes an issue, link it:
"Fixes #12". If there's no issue and this is more than a small fix, please open
one first — see CONTRIBUTING.md.
-->

## How you tested it

<!--
Be honest about what you did and didn't check. "Typechecks and builds, tested
the import path by hand on ~200 JPEGs, did not test with RAW" is a genuinely
useful sentence.

Testing the UI is the maintainer's job — you are not expected to script a
browser.
-->

## Checklist

- [ ] `cd backend && pytest` passes
- [ ] `cd frontend && npx tsc --noEmit && npm run build` passes
- [ ] Comments explaining *why* were added where the reasoning isn't obvious, and
      any comment I made stale was updated (see CONTRIBUTING.md)
- [ ] Tests added, or I've said why they weren't
- [ ] I agree to license this under the project's [MIT Licence](../LICENSE)
