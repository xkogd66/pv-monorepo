# PhotoVault Monorepo — CLAUDE.md

## Project Overview

**PhotoVault (pv)** is a Kubernetes-native photo gallery and storage platform. It handles photo uploads, HEIC/JPEG to AVIF conversion, EXIF metadata extraction, location-based tagging, and album management. All services run in a self-hosted K3s cluster.

---

## Context Sources

For context, read **this file** and **[IMPLEMENTATION_DETAILS.md](IMPLEMENTATION_DETAILS.md)** (how each feature is built, with its trade-offs and known gaps). [USER_MANUAL.md](USER_MANUAL.md) describes the features from the user's side.

**Do not read source code unless I authorize it.** Answer from these documents first. If they are not enough, say what you need and ask before opening code files. This does not apply to files you are about to edit at my request.

---

## Cluster Access

Never run `kubectl` (or any other command that reads/touches the live K3s cluster) yourself. Always print the exact command and ask the user to run it and paste back the output. This applies to read-only commands (`kubectl get`, `describe`, `logs`) as well as mutating ones.

---

## File Deletion

Never run `rm`, `git rm`, `rm -rf`, or any other command that deletes files or directories yourself — no exceptions, even for files that look obviously safe (build artifacts, a directory being deprecated, scratch files you created). Instead, tell the user exactly what needs to be deleted and why, and ask them to delete it themselves (or give explicit go-ahead for you to run the exact command).

---

## Visual Verification

Do not attempt to visually verify UI changes yourself (screenshots, headless browser driving, etc.), and do not run build or dev-server commands (`npm run build`, `npm run dev`, `vite build`, etc.) to self-verify either. Make the code change, then explicitly ask the user to build/run/check it themselves (dev server or real environment). Do not claim a UI change "looks correct" or "works" based on your own screenshot or build output — you cannot see, and simulated verification is not a substitute for a human actually checking it.

---

## Explain Reasoning

Always explain the reasoning behind a change before or alongside making it — not just what was edited, but what problem it solves, why this approach over alternatives, and any capability or behavior being traded away (especially when removing/replacing existing functionality). Don't let a removed capability surface later as a bug report — flag it up front.

This applies to **decisions**: what was chosen, why, and what it costs. It does not mean narrating your own tool calls — see Output Style.

---

## Output Style

Say less. The user reads the diff and the command output, not a transcript of your intentions.

- **No pre-tool narration.** Never announce a tool call ("let me check X", "now I'll read Y", "I need to look at Z"). Call the tool.
- **No post-tool narration.** Don't restate a result the user can already see in the tool output.
- **Batch independent tool calls** into one turn rather than serializing them one at a time. Fewer round-trips, less scroll.
- **Status prose only when it earns its place:** a decision you are making, a blocker, or a long-running operation that needs expectation-setting. Otherwise emit nothing between tool calls.
- **Final summary:** what changed, what you verified, what you assumed or could not verify. Not a play-by-play of the steps taken.
- **Report errors and surprises immediately** — that prose always earns its place.

Still required: the Explain Reasoning rule above, blockers, destructive-action warnings, and anything the user must run themselves (Cluster Access, Visual Verification).
