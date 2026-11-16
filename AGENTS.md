# AGENTS.md

Instructions for AI coding agents working in this repository (Claude Code, Codex, Cursor, Windsurf, GitHub Copilot, Gemini CLI, Antigravity, Zed, Aider, …). Tools that do not read this file directly have a pointer file: `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Compatibility: every IDE, every OS

This extension must keep working in **every VS Code-based IDE** (VS Code, VS Code Insiders, VSCodium, Antigravity, Cursor, Windsurf, Trae, Kiro, Positron, …) and on **macOS, Windows and Linux**. Treat a change that only works in one of them as a bug.

**IDEs**
- Use only the stable `vscode` API available in `engines.vscode` (`^1.90.0`). Forks lag behind upstream: no proposed APIs, nothing newer than the engine range.
- Never hard-code an IDE's name, product folder, app path or data folder. Derive them at runtime (`vscode.env.appRoot`, `vscode.env.appName`, `ctx.globalStorageUri`, `product.json`).
- Use only workbench command IDs and contribution points that exist upstream (e.g. `workbench.action.closeSidebar`, `viewsContainers.activitybar`). Forks may move or hide UI (Cursor's horizontal activity bar, Antigravity's agent panel), so every feature must also be reachable from a command, the Command Palette and the status bar.
- The extension ships to both the VS Code Marketplace and Open VSX (VSCodium, Cursor, Windsurf, Antigravity install from Open VSX). Don't depend on Marketplace-only features.
- The runtime (`src/runtime`) runs inside the IDE's own workbench: keep it self-contained, avoid selectors tied to one IDE's DOM, and degrade quietly when an element is missing.

**Operating systems**
- Build paths with `path.join` / `path.resolve` / `vscode.Uri`; never concatenate with `/` or `\`. Compare file paths case-insensitively where the OS is (Windows, default macOS).
- Don't shell out to OS-specific tools (`open`, `xdg-open`, `start`, `cp`, `rm`). Use Node APIs or `vscode.env.openExternal` / `revealFileInOS`.
- Put platform branches in one small function that takes `platform` as a parameter (see `permissionHelp` in `src/core/patcher.ts`) and cover each branch in `test/platform.test.ts`.
- Remember the special cases already handled: Windows `Program Files` + elevated PowerShell, macOS app bundles owned by another account, Linux root-owned installs, read-only Snap / Flatpak, OneDrive-redirected Pictures folders, XDG user dirs.
- Line endings and encodings: read and write text as UTF-8; don't assume `\n` in files the IDE produced.

**Verify before calling it done**
1. `npm run typecheck` → no errors
2. `npm test` → all tests pass (CI runs on ubuntu, windows and macos; keep tests OS-independent, use `os.tmpdir()` and `path`)
3. `npm run build` → bundle builds
4. For UI or runtime changes, say which IDE(s) and OS you actually tried, and which you didn't.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
