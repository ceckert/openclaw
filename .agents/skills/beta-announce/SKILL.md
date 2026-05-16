---
name: beta-announce
description: "Draft and copy OpenClaw beta Discord announcements from changelog highlights, test focus, and beta update commands."
---

# Beta Announce

Use for OpenClaw beta Discord announcements, prerelease test calls, changelog-to-Discord summaries, and clipboard-ready beta update instructions.

## Ground Truth

- Read the exact beta version from `package.json` or the release tag. Include the full prerelease suffix, for example `2026.5.16-beta.3`.
- Read the full relevant `CHANGELOG.md` range. If the user says "since .12", treat it as the same year/month stable release anchor, for example `v2026.5.12`.
- Verify beta install/update commands from repo docs or `../openclaw.ai` source when available.
- Do not invent shipped features. If tag/npm/release state is uncertain, say beta wording and avoid stable claims.

## Discord Shape

- First line: `OpenClaw VERSION 🦞 is ready for testing. ...`
- Use Markdown section labels:
  - `Highlights:`
  - `Beta test focus:`
  - `How to install or update the beta:`
  - `If you hit a regression, please include:`
- Blank line between sections is fine.
- Bullets are fine. One bullet per physical line.
- Do not hard-wrap normal sentences or bullets. Never split one sentence onto a new physical line just because it is long.
- Keep it beta-focused. Do not include stable install/update links or stable-channel guidance unless explicitly asked.

## Content Priorities

- Lead with user-visible wins: new providers/auth, CLI workflows, onboarding/localization, channel behavior, Codex/runtime reliability, Control UI/WebChat improvements, install/update/doctor reliability, provider/media hardening.
- Test focus should name concrete surfaces to exercise, not just feature categories.
- Keep maintainer/CI/release validation details out unless they directly affect what beta users should test.
- Tone: concise, direct, a little dry; not corporate.

## Beta Commands

- Existing installs: `openclaw update --channel beta`
- New beta install or recovery on macOS/Linux: `curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta`
- Windows beta: `powershell -c "& ([scriptblock]::Create((irm https://openclaw.ai/install.ps1))) -Tag beta"`

## Clipboard

- When the user asks to copy, use `pbcopy`.
- Verify with `pbpaste` enough to catch version, lobster emoji, section breaks, and line wrapping.
- If the user corrects formatting, preserve the latest formatting preference in the copied version.
