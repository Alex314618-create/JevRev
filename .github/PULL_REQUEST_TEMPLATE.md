<!--
One change per pull request. If this diff does two unrelated things, please split it.

If you are unsure whether this belongs here, CONTRIBUTING.md lists the surface we
can merge directly and the surface that needs an issue first.
-->

## What this changes

<!-- A short description of the change itself. -->

## Why

<!-- The problem it solves, or the failing case that motivated it. -->

## Evidence

<!--
Required. This is the section reviewers read first.

Paste the command you ran and its raw result. If you measured a
number, say what machine and OS you measured it on, because timing numbers do not
travel. If this change is documentation only, say so and link the lines you
corrected.
-->

```text
command:
result:
platform:
```

## Does this change a claim or a contract?

- [ ] It changes a documented claim in the README or in `docs/`
- [ ] It changes a JSON schema, a CLI contract, or a frozen spec
- [ ] Neither

If you ticked either of the first two, please open or link the issue where the
change was agreed.

## Checklist

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Every claim in this change is backed by a run recorded above
- [ ] Shipped and roadmap capabilities are still labelled accurately
- [ ] If a claim changed, `docs/ACCEPTANCE.md` is updated in this same pull request
