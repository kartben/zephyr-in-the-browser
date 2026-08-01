# CLAUDE.md

## Writing style

- Don't use em dashes (`—`) in prose, code comments, commit messages, changelog
  entries, or PR text. Use a colon, comma, parentheses, or two sentences instead.

## Changelog (`CHANGELOG.md`)

- Keep entries short: one concise line, generally 10 words or less, like the
  existing bullets.
- Only add an entry for something genuinely notable: an important new
  capability, or a fix for a bug that shipped in a **previous** release. Do
  **not** add an entry for a bug introduced and fixed within the current
  unreleased cycle.
- Before adding a bullet, check whether it folds into an existing one for the
  same release rather than adding another line.
- After editing CHANGELOG.md, run `node scripts/gen-changelog.mjs` to regenerate
  `src/changelog.ts` so the in-app help dialog stays in sync.

## App releases vs asset releases

- App semver lives in `package.json` as `X.Y.Z-dev` and is cut by the **Release**
  workflow (`.github/workflows/release.yml`) via `scripts/release.mjs`. Tags look
  like `v0.6.0`.
- Emulator and guest-image assets still use plain `vN` tags from
  `tools/release.sh`. Those are unrelated to the app version.

## Before proposing/creating a PR

Always run these checks locally first (they mirror `.github/workflows/ci.yml`)
and fix any failures before proposing a PR:

```bash
npm run typecheck
npm test
```
