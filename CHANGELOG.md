# Changelog

## 1.3.1

- **Fix: wallpapers missing after an update.** When *Library path* is empty, the automatic folder (`<Pictures>/IDE Wallpapers`, or `~/IDE Wallpapers`) can differ between versions or change when the Pictures folder is created later, so a library full of GIFs and videos could look empty. The extension now keeps using the folder that already holds your wallpapers. New installs are unchanged.

## 1.3.0

- **Keeps playing when the IDE isn't focused.** GIFs, videos and pixel themes no longer freeze when you switch to another app; they still pause when the IDE is minimized or hidden. *Pause when the IDE is not focused* is now off by default (existing installs are switched once) and can be turned back on in the picker.
- **Cheaper blur.** Blurred wallpapers are drawn into a small canvas and upscaled by the GPU instead of re-blurring the whole screen on every frame. Still images are blurred once; GIFs are decoded with `ImageDecoder`.
- **Optimize videos too.** *Optimize Heavy GIFs & Videos* re-encodes videos larger than the screen, above 30 fps, or in a codec the GPU can't decode. The codec is picked from what the IDE decodes in hardware (H.264, HEVC, VP9 or AV1). Audio tracks are dropped, `.mp4` files keep their name, and originals go to `.originals`.
- **Lighter runtime.** The workbench polls a few-byte revision file instead of the whole state, and reacts to theme and panel colour changes through observers instead of checking every second. Pixel themes paint their static scenery once and use an opaque canvas.
- **Faster startup.** The extension reads only the end of the IDE bundle to check the runtime, hashes it only after the IDE changed, remembers the library folder, and reads the state from disk only when it changed.
## 1.2.0

- **MCP server for chat / agent apps** (Claude desktop, Antigravity 2.0, Claude Code, Cursor…): set the OS desktop wallpaper (macOS, Windows, Linux GNOME / KDE Plasma / Cinnamon / MATE), switch, rotate or turn off the wallpaper in every IDE that has the extension, list and add wallpapers, all by chat. Ships on GitHub Releases as a `.mcpb` (one-click install in Claude desktop) and a standalone `live-wallpaper-studio-mcp.js`.

## 1.1.5

- IDE installed for all users (Linux .deb / .rpm under `/usr/share`, Windows Program Files, macOS app owned by another account): a new **Use administrator password** button installs, updates or removes the runtime through the system's own prompt (pkexec on Linux, the administrator dialog on macOS, UAC on Windows). No terminal needed.
- The copy-paste fallback is now `sudo env ELECTRON_RUN_AS_NODE=1 …`, which also works where sudoers forbids `sudo VAR=… command`.
- *Remove Runtime and Restore the IDE* offers the same administrator prompt instead of failing.
- After an extension update on such installs, the prompt appears once per version instead of on every start.

## 1.1.4

- Uninstalling the extension turns the wallpaper (and the translucent *See-through* frame) off within a few seconds, without waiting for the IDE to restart.
- Restoring the IDE also removes the backup files (`*.wallpaper-studio.bak`).
- Picker in the sidebar: a single "Live Wallpaper Studio" title, the search box on its own row, no more wrapped header.

## 1.1.3

- The wallpaper picker now has its own icon in the Activity Bar (left sidebar) instead of a tab in the bottom panel, and opens automatically the first time after install. You can still drag it to the panel if you prefer.

## 1.1.2

- *See-through* mode looks even on light themes and in VS Code: nested surfaces (tab bar, breadcrumbs, sidebar headers, lists, VS Code modern-UI tabs) no longer stack into lighter or darker patches.
- Highlights stay subtle: the active tab, current line, inputs and the command center get a light tint instead of a solid block. The minimap no longer forms a bright rectangle.
- The picker's search box and dropdowns are translucent, so they don't punch holes in the wallpaper.
- New GitHub README. The marketplace page has its own extension-focused README with a commands table.

## 1.1.1

- New animated previews on the marketplace page, recorded in Antigravity IDE with a dark theme.

## 1.1.0

- **English UI.** The picker, messages, status bar, commands and settings are now in English, and Vietnamese is still fully supported. The language follows the IDE display language, or set `wallpaperStudio.language` (`auto` / `en` / `vi`).
- Pixel themes have English names: City Rain, Starry Night, Snowfall, Tết Blossoms, Lanterns, Code Rain.
- *See-through* mode now works with the new VS Code "modern UI" (floating panels): the shell background and nested sidebar lists no longer cover the wallpaper.
- Uninstalling now also restores newer VS Code builds that keep the app in a version folder (`<install>/<commit>/resources/app`).
- Marketplace page rewritten in English, with animated previews.

## 1.0.1

- Automated publishing to Open VSX (Antigravity IDE) and the VS Code Marketplace through GitHub Actions.
- Automated tests on Windows, macOS and Linux.

## 1.0.0

- First release of Live Wallpaper Studio for VS Code and Antigravity IDE.
- Wallpaper picker in the panel with instant live preview and keyboard shortcuts.
- One-time runtime install: switching wallpapers needs no reload. The IDE checksum is kept in sync.
- The library is a plain folder, plus metadata (favorites, day/night, per-image strength, display names).
- Images, GIFs, videos (MP4, and WebM through hard links) and 6 pixel themes.
- *Overlay* and *See-through* modes (translucent editor, sidebar and terminal).
- Auto-rotation (in order or shuffled), a day/night schedule and per-project wallpapers.
- GIF → MP4 optimization (ffmpeg), adding images from a URL, drag and drop.
- Settings are migrated from `shalldie.background`. The extension offers a repair after an IDE update and restores the IDE when uninstalled.
- Windows, macOS and Linux.
- Fixed: removing a ☀/☾ tag, a ★ favorite, a per-image strength or a project wallpaper now works.
