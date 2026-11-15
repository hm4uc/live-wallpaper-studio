/**
 * Tiny i18n shared by the extension host and the picker webview.
 * Keys are the English strings (English is the fallback); `{0}`, `{1}` … are placeholders.
 * package.json contributions are localized separately via package.nls*.json.
 */
export type Lang = 'en' | 'vi';

const VI: Record<string, string> = {
  // ---- extension host: library / media
  'Skipped {0} unsupported file(s): {1}': 'Bỏ qua {0} file không hỗ trợ: {1}',
  'Downloading wallpaper…': 'Đang tải ảnh nền…',
  'ffmpeg not found. Install it (e.g. winget install ffmpeg / brew install ffmpeg / apt install ffmpeg) or set "wallpaperStudio.ffmpegPath".':
    'Không tìm thấy ffmpeg. Cài ffmpeg (vd: winget install ffmpeg / brew install ffmpeg / apt install ffmpeg) hoặc đặt "wallpaperStudio.ffmpegPath".',
  'No heavy GIFs to optimize. (GIFs smaller than ~900×500 use less CPU as GIF than as video.)':
    'Không có GIF nặng nào cần tối ưu. (GIF nhỏ hơn ~900×500 giữ nguyên dạng GIF sẽ nhẹ hơn video.)',
  'Optimizing GIF → MP4': 'Đang tối ưu GIF → MP4',
  'Optimizing {0} failed: {1}': 'Tối ưu {0} thất bại: {1}',
  'Optimized {0} GIF(s), saved {1} MB. The originals are in the .originals folder.': 'Đã tối ưu {0} GIF, tiết kiệm {1} MB. File gốc nằm trong thư mục .originals.',
  'Only http(s) links are supported': 'Chỉ hỗ trợ link http(s)',
  'Download failed: HTTP {0}': 'Tải thất bại: HTTP {0}',
  'File too large (> 300 MB)': 'File quá lớn (> 300MB)',
  'The link is not a supported image / GIF / video ({0})': 'Link không phải ảnh/GIF/video được hỗ trợ ({0})',
  'Live Wallpaper Studio: moved {0} image(s) from your old settings into the library {1}.': 'Live Wallpaper Studio: đã chuyển {0} ảnh từ cấu hình cũ vào thư viện {1}.',

  // ---- extension host: display / selection
  '"See-through" mode: to make the terminal transparent too, terminal GPU acceleration must be off (terminal.integrated.gpuAcceleration = off). Turn it off now?':
    'Chế độ "Xuyên khung": để terminal cũng trong suốt, cần tắt GPU cho terminal (terminal.integrated.gpuAcceleration = off). Tắt luôn?',
  Yes: 'Có',
  No: 'Không',
  'This window has no project or folder open.': 'Cửa sổ này chưa mở project/thư mục nào.',

  // ---- extension host: status bar
  '$(warning) Wallpaper: reload needed': '$(warning) Wallpaper: cần reload',
  'Runtime installed. Reload the window once to turn the wallpaper on.': 'Runtime đã được cài. Reload cửa sổ một lần để bật ảnh nền.',
  '$(warning) Wallpaper: not installed': '$(warning) Wallpaper: chưa cài',
  'Click to install the wallpaper runtime (one time).': 'Bấm để cài runtime ảnh nền (1 lần).',
  Off: 'Tắt',
  'Showing: **{0}**': 'Đang hiển thị: **{0}**',
  'Wallpaper is off': 'Ảnh nền đang tắt',
  ' _(project wallpaper)_': ' _(ảnh riêng của project)_',
  'Next change in: {0}': 'Tự đổi sau: {0}',
  'Click: quick menu · `Ctrl+Alt+W`: picker · `Ctrl+Alt+]` / `[`: next / previous': 'Click: menu nhanh · `Ctrl+Alt+W`: bộ chọn · `Ctrl+Alt+]` / `[`: kế / trước',
  '{0} sec': '{0} giây',
  '{0} min': '{0} phút',
  '{0} h': '{0} giờ',

  // ---- extension host: runtime install
  'The wallpaper was removed by an IDE update. Re-apply it? (one reload needed)': 'Ảnh nền đã mất sau khi IDE cập nhật. Áp dụng lại? (cần reload 1 lần)',
  'Live Wallpaper Studio needs to install its runtime into the IDE once (after that, switching wallpapers needs no reload).':
    'Live Wallpaper Studio cần cài runtime vào IDE một lần (sau đó đổi ảnh không cần reload).',
  'Re-apply': 'Áp dụng lại',
  'Install & Reload': 'Cài đặt & Reload',
  Later: 'Để sau',
  'Live Wallpaper Studio is installed. Reload the window to turn the wallpaper on.': 'Đã cài Live Wallpaper Studio. Reload cửa sổ để bật ảnh nền.',
  'Reload now': 'Reload ngay',
  'Copy fix command': 'Sao chép lệnh sửa',
  "Can't write the IDE's files ({0}). {1}": 'Không ghi được file của IDE ({0}). {1}',
  ' Run the copied command in a terminal (as administrator), then reload.': ' Chạy lệnh đã sao chép trong terminal (quyền quản trị) rồi Reload.',
  'Installing the runtime failed: {0}': 'Cài runtime thất bại: {0}',
  'Remove the wallpaper runtime from the IDE? Your image library is kept.': 'Gỡ runtime ảnh nền khỏi IDE? Thư viện ảnh của bạn được giữ nguyên.',
  Remove: 'Gỡ',
  'The IDE has been restored. Reload to finish.': 'Đã khôi phục IDE gốc. Reload để hoàn tất.',
  'Removal failed: {0}': 'Gỡ thất bại: {0}',
  'The IDE is installed as a Snap/Flatpak (read-only folder), so the wallpaper cannot be installed. Use the .deb / .rpm / .tar.gz build of the IDE.':
    'IDE được cài dạng Snap/Flatpak (thư mục chỉ-đọc) nên không thể cài ảnh nền. Hãy dùng bản .deb / .rpm / .tar.gz của IDE.',
  'The IDE is installed for all users (the folder needs Administrator rights).': 'IDE được cài cho mọi người dùng (thư mục cần quyền Administrator).',
  'The IDE app belongs to another account / an administrator.': 'Ứng dụng IDE thuộc quyền tài khoản khác / quản trị viên.',
  'The IDE install folder is owned by root.': 'Thư mục cài IDE thuộc quyền root.',

  // ---- commands / quick pick
  '1 minute': '1 phút',
  '5 minutes': '5 phút',
  '15 minutes': '15 phút',
  '30 minutes': '30 phút',
  '1 hour': '1 giờ',
  '3 hours': '3 giờ',
  'Add to library': 'Thêm vào thư viện',
  'Images, GIFs, videos': 'Ảnh, GIF, video',
  'Paste an image / GIF / video link (https://…)': 'Dán link ảnh / GIF / video (https://…)',
  'The link must start with http(s)://': 'Link phải bắt đầu bằng http(s)://',
  'Change the wallpaper every…': 'Tự đổi ảnh nền sau mỗi…',
  'In order': 'Lần lượt',
  'Shuffle (no repeats until every image has been shown)': 'Ngẫu nhiên (không lặp lại đến khi hết vòng)',
  Order: 'Thứ tự',
  'Open wallpaper picker': 'Mở bộ chọn ảnh nền',
  'Next wallpaper': 'Ảnh kế tiếp',
  'Previous wallpaper': 'Ảnh trước đó',
  'Random wallpaper': 'Ảnh ngẫu nhiên',
  'Turn wallpaper off': 'Tắt ảnh nền',
  'Turn wallpaper on': 'Bật ảnh nền',
  'Auto-rotate': 'Tự đổi ảnh',
  ' · in {0}': ' · còn {0}',
  'Add images / GIFs / videos…': 'Thêm ảnh / GIF / video…',
  'Add from URL…': 'Thêm từ URL…',
  'Open wallpaper folder': 'Mở thư mục ảnh',
  'Live Wallpaper Studio — type to search': 'Live Wallpaper Studio — gõ để tìm ảnh',
  'Library: {0} ({1} files)': 'Thư viện: {0} ({1} file)',
  'Showing: {0} [{1}]': 'Đang hiển thị: {0} [{1}]',
  '(off)': '(tắt)',
  'Display name': 'Tên hiển thị',
  'Hide theme "{0}"? (you can show it again later)': 'Ẩn theme "{0}"? (có thể hiện lại sau)',
  'Delete "{0}"? The file will be moved to the trash.': 'Xoá "{0}"? File sẽ được chuyển vào Thùng rác.',
  Hide: 'Ẩn',
  Delete: 'Xoá',

  // ---- pixel themes
  'City Rain': 'Mưa phố',
  'Starry Night': 'Trời sao',
  Snowfall: 'Tuyết rơi',
  'Tết Blossoms': 'Hoa mai Tết',
  Lanterns: 'Đèn lồng',
  'Code Rain': 'Mưa mã',

  // ---- picker webview
  Image: 'Ảnh',
  'Paste an image / GIF / video link, then Enter…': 'Dán link ảnh / GIF / video rồi Enter…',
  'Search…': 'Tìm…',
  'Search wallpapers': 'Tìm ảnh',
  'Wallpaper list': 'Danh sách ảnh nền',
  'Drop images / GIFs / videos here to add them to the library': 'Thả ảnh / GIF / video vào đây để thêm vào thư viện',
  '← → choose · ↵ apply · esc close': '← → chọn · ↵ áp dụng · esc đóng',
  'Add image / GIF / video': 'Thêm ảnh / GIF / video',
  'Add from URL': 'Thêm từ URL',
  'Downloading…': 'Đang tải…',
  All: 'Tất cả',
  '★ Favorites': '★ Yêu thích',
  Favorite: 'Yêu thích',
  Day: 'Ban ngày',
  Night: 'Ban đêm',
  'Wallpaper for this project': 'Ảnh riêng của project này',
  'High-resolution GIF — right-click → Optimize to MP4 to reduce CPU': 'GIF độ phân giải lớn — chuột phải → Tối ưu sang MP4 để giảm CPU',
  Add: 'Thêm',
  'No matching wallpapers.': 'Không có ảnh nào khớp.',
  Apply: 'Áp dụng',
  '☆ Remove from favorites': '☆ Bỏ yêu thích',
  '★ Add to favorites': '★ Yêu thích',
  '✓ ☀ Daytime (click to remove)': '✓ ☀ Ban ngày (bấm để bỏ)',
  '☀ Use in the daytime': '☀ Gán ban ngày',
  '✓ ☾ Night-time (click to remove)': '✓ ☾ Ban đêm (bấm để bỏ)',
  '☾ Use at night': '☾ Gán ban đêm',
  '✓ ⌂ Wallpaper for this project (click to remove)': '✓ ⌂ Ảnh riêng của project này (bấm để bỏ)',
  '⌂ Use only for this project': '⌂ Dùng riêng cho project này',
  'Own strength: {0}% (click to remove)': 'Độ rõ riêng: {0}% (bấm để bỏ)',
  'Use the current strength as this image’s default': 'Dùng độ rõ hiện tại làm mặc định cho ảnh này',
  'Rename…': 'Đổi tên…',
  '⚡ Optimize: convert GIF → MP4 (less CPU)': '⚡ Tối ưu: chuyển GIF → MP4 (giảm CPU)',
  'Convert GIF → MP4 (smaller file; small GIFs are already light on CPU)': 'Chuyển GIF → MP4 (giảm dung lượng; GIF nhỏ vốn đã nhẹ CPU)',
  'Show in folder': 'Mở trong thư mục',
  'Hide this theme': 'Ẩn theme này',
  'Delete (move to trash)': 'Xoá (chuyển vào Thùng rác)',
  'Image strength': 'Độ rõ ảnh',
  'Strength': 'Độ rõ nền',
  'Frame opacity': 'Độ đục khung',
  Density: 'Mật độ',
  Speed: 'Tốc độ',
  Mode: 'Chế độ',
  'Overlay on top': 'Phủ mờ lên trên',
  'See-through (behind the UI)': 'Xuyên khung (nền phía sau)',
  Rotate: 'Tự đổi',
  Shuffle: 'Ngẫu nhiên',
  Source: 'Nguồn',
  '★ only': 'Chỉ ★',
  'Hide advanced ▴': 'Ẩn nâng cao ▴',
  'Advanced ▾': 'Nâng cao ▾',
  Fit: 'Hiển thị',
  Cover: 'Phủ kín',
  Contain: 'Vừa khung',
  Stretch: 'Kéo giãn',
  'Original size, centered': 'Giữ nguyên, ở giữa',
  Tile: 'Lát gạch',
  Position: 'Vị trí',
  Center: 'Giữa',
  Top: 'Trên',
  Bottom: 'Dưới',
  Left: 'Trái',
  Right: 'Phải',
  'Bottom right': 'Góc phải dưới',
  'Bottom left': 'Góc trái dưới',
  Blend: 'Hoà trộn',
  Auto: 'Tự động',
  Normal: 'Bình thường',
  Blur: 'Làm mờ',
  'Switch by time of day (☀ day / ☾ night images)': 'Tự đổi theo giờ (ảnh ☀ ban ngày, ☾ ban đêm)',
  '☀ from': '☀ từ',
  '☾ from': '☾ từ',
  'Pause when the IDE is not focused (saves battery)': 'Tạm dừng khi IDE không focus (tiết kiệm pin)',
  'Folder: ': 'Thư mục: ',
  'Show {0} hidden theme(s)': 'Hiện lại {0} theme đã ẩn',
  'Optimize heavy GIFs': 'Tối ưu GIF nặng',
  'Remove runtime': 'Gỡ runtime',
  '✅ Runtime installed. Reload the window once to turn the wallpaper on.': '✅ Đã cài runtime. Reload cửa sổ 1 lần để bật ảnh nền.',
  'Runtime error': 'Lỗi runtime',
  '⚠ The wallpaper runtime is not installed in the IDE yet (one time only).': '⚠ Chưa cài runtime ảnh nền vào IDE (chỉ cần 1 lần).',
  Install: 'Cài đặt',
  '⌂ project wallpaper': '⌂ ảnh riêng project',
  '⟳ next in {0}': '⟳ đổi sau {0}',
  '{0} is too large (> 300 MB)': '{0} quá lớn (> 300MB)',
  'Adding {0} file(s)…': 'Đang thêm {0} file…',
  'No valid image / GIF / video files': 'Không có file ảnh/GIF/video hợp lệ',
};

const DICTS: Record<Lang, Record<string, string> | null> = { en: null, vi: VI };
let lang: Lang = 'en';

/** `setting` = wallpaperStudio.language ('auto' | 'en' | 'vi'); `ide` = vscode.env.language. */
export function resolveLang(setting: string | undefined, ide: string | undefined): Lang {
  if (setting === 'en' || setting === 'vi') return setting;
  return /^vi\b/i.test(ide ?? '') ? 'vi' : 'en';
}

export function setLang(l: Lang) {
  lang = l;
}

export function getLang(): Lang {
  return lang;
}

export function t(key: string, ...args: (string | number)[]): string {
  const s = DICTS[lang]?.[key] ?? key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m)) : s;
}

/** For tests: every key that has a translation. */
export const VI_KEYS = Object.keys(VI);
