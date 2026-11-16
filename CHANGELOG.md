# Changelog

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
