# JevRev release process

Tagline: **Pick the right path before you build.**

Current tagged version: `v0.1.0`

The existing `v0.1.0` tag predates the automated release workflow. Do not move
or recreate it. The first automated npm release must use a new package version
and matching tag.

## Automated publish sequence

Publishing is gated by a GitHub Release. Before creating one:

1. Merge a pull request whose CI matrix is green.
2. Update `package.json` and `CHANGELOG.md` to the intended version.
3. Create and push the matching `v<version>` tag from the verified commit.
4. Publish a GitHub Release for that tag.

The release workflow rejects a tag that does not exactly match the package
version, repeats the TypeScript checks, tests, build, Python runtime tests, and
package-content verification, then publishes with npm provenance.

Configure npm Trusted Publishing for this repository and
`.github/workflows/release.yml`. The workflow uses GitHub OIDC and does not
require a long-lived npm token.

`workflow_dispatch` performs the entire verification path without publishing.

## Local verification

```bash
npm ci
npm run check
npm test
npm run build
npm run verify:pack
```

Repository: https://github.com/Alex314618-create/JevRev

The package metadata points at the public repository above. The pack verifier
rejects source files, tests, source maps, Python caches, benchmark results, and
`.env`. Never publish a live API key or local model.

## Included

- compiled `jevrev` CLI and `specjev` compatibility binary;
- Jev/TypeSafe, SemIf, legacy local, and replay providers;
- request/response protocol and integration skill;
- three request examples and offline demo fixtures;
- local model lifecycle scripts and an at-least-five-repetition benchmark harness.

See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the recorded checks and
known boundaries.
