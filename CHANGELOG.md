# Changelog

## Unreleased

- Add cross-platform Node.js and Python CI matrices.
- Add automated npm publishing through GitHub Releases with version gating and
  provenance.
- Verify the exact npm package contents before release and exclude generated
  source maps from the published artifact.
- Add weekly Dependabot updates for npm and GitHub Actions dependencies.

## 0.1.0 — 2026-09-20

First JevRev release.

- `jevrev run` accepts structured candidate cards from a file or stdin.
- `jevrev rank` and the `specjev` binary remain compatibility aliases.
- Official Jev/TypeSafe, local SemIf, replay, and legacy reranker providers are
  available through one typed response contract.
- `--jev-url`, `--semif-url`, `--local-url`, `--output`, and `doctor` expose the
  integration surface needed by shell scripts and coding agents.
- Three realistic request scenarios, offline fixtures, module tests, and a
  at-least-five-repetition benchmark harness are included.
