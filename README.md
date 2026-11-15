# Live Wallpaper Studio

Ảnh nền, GIF, video và **pixel theme động** cho **VS Code** và **Antigravity IDE** (cùng các bản fork khác của VS Code).
Chọn ảnh bằng giao diện, **đổi tức thì không cần reload**, tự đổi theo lịch. Chạy trên Windows, macOS và Linux.

> *English summary:* background images / GIFs / videos / animated pixel themes for VS Code and Antigravity IDE (and other VS Code forks). Visual picker with live preview, instant switching (no reload after the one-time setup), rotation schedules, day/night playlists, per-project wallpapers. Windows, macOS, Linux.

## Tính năng

- **Bộ chọn trực quan** (`Ctrl+Alt+W`): lưới thumbnail, dùng `← →` để xem trước trực tiếp trên IDE, `Enter` để áp dụng, `Esc` để quay về ảnh cũ.
- **Đổi tức thì**: chỉ cần reload 1 lần lúc cài. Sau đó mọi thao tác (đổi ảnh, chỉnh thanh trượt, tự đổi) áp dụng ngay lập tức.
- **Thư viện là một thư mục thường**: `<thư mục Ảnh>/IDE Wallpapers` (Windows đọc vị trí thư mục Ảnh thật nhưng bỏ qua OneDrive; Linux theo XDG; nếu không có thì dùng `~/IDE Wallpapers`). Thả file vào là ảnh hiện ngay. Có thể thêm bằng nút ＋, kéo thả, hoặc dán URL.
- **Hỗ trợ** PNG, JPG, WebP, BMP, SVG, AVIF, **GIF**, **MP4**, **WebM**, MOV.
- **6 pixel theme vẽ bằng code** (nhẹ hơn GIF rất nhiều): Mưa phố, Trời sao, Tuyết rơi, Hoa mai Tết, Đèn lồng, Mưa mã. Có thanh trượt *Mật độ* và *Tốc độ*.
- **Hai chế độ hiển thị**:
  - *Phủ mờ*: lớp ảnh mờ phủ lên trên, hợp với mọi theme.
  - *Xuyên khung*: ảnh nằm phía sau, editor/sidebar/terminal trong suốt theo thanh *Độ đục khung*.
- **Tự đổi ảnh**: chu kỳ từ 1 phút đến 3 giờ, lần lượt hoặc ngẫu nhiên (không lặp lại cho đến khi hết vòng), có thể chỉ xoay vòng ảnh ★. Nhiều cửa sổ IDE luôn hiển thị cùng một ảnh.
- **Ngày / đêm**: gắn ảnh ☀ hoặc ☾, IDE tự đổi theo giờ.
- **Ảnh riêng cho từng project**.
- **Tiết kiệm tài nguyên**: GIF bị đóng băng và video/theme tạm dừng khi IDE không có focus. Tôn trọng chế độ *giảm chuyển động* của hệ điều hành. Có thể chuyển GIF nặng sang MP4 bằng ffmpeg.

## Phím tắt

| Thao tác | Windows / Linux | macOS |
|---|---|---|
| Mở bộ chọn | `Ctrl+Alt+W` | `⌃⌥W` |
| Ảnh kế / trước | `Ctrl+Alt+]` / `Ctrl+Alt+[` | `⌃⌥]` / `⌃⌥[` |
| Bật / tắt nền | `Ctrl+Alt+0` | `⌃⌥0` |

Trong bộ chọn: `← → ↑ ↓` xem trước · `Enter` áp dụng · `Esc` huỷ và đóng · `F` yêu thích · `Delete` xoá · gõ chữ để tìm · chuột phải để mở thêm tuỳ chọn.

Nếu bàn phím của bạn dùng AltGr (ví dụ bố cục Đức hoặc Ba Lan), `Ctrl+Alt+…` có thể trùng với việc gõ ký tự. Bạn có thể đổi phím trong *Keyboard Shortcuts* bằng cách tìm `wallpaperStudio`.

## Cài đặt lần đầu

1. Cài extension.
2. Bấm **Cài đặt & Reload** ở thông báo hiện lên (hoặc chạy lệnh `Wallpaper: Cài đặt / sửa lại runtime`).
3. Xong. Từ giờ không cần reload nữa.

Nếu bạn đang dùng extension `shalldie.background`, cấu hình ảnh của nó sẽ được tự động chuyển vào thư viện, và bản patch cũ sẽ được gỡ để tránh hai lớp nền chồng lên nhau.

### Vì sao cần "cài runtime"?

VS Code không cho extension vẽ lên giao diện chính. Live Wallpaper Studio thêm **một lần** một đoạn script nhỏ (~21KB) vào file giao diện của IDE. Đoạn script này không chứa đường dẫn ảnh nào, nó chỉ đọc file cấu hình `state.json` rồi vẽ theo. Vì vậy đổi ảnh không cần sửa file IDE thêm lần nào nữa.

- Checksum trong `product.json` được cập nhật theo, nên IDE **không** báo "installation corrupt" (sau lần khởi động lại đầu tiên).
- File gốc được sao lưu (`*.wallpaper-studio.bak`). Lệnh `Wallpaper: Gỡ runtime` khôi phục IDE về nguyên bản, và gỡ extension cũng tự khôi phục.
- Sau khi IDE **tự cập nhật**, bản patch sẽ mất. Extension sẽ hỏi *Áp dụng lại* (1 click).

### Quyền ghi theo hệ điều hành

| Hệ điều hành | Thường gặp | Cách xử lý |
|---|---|---|
| Windows (cài cho user) | Không cần làm gì | — |
| Windows (Program Files) | Cần quyền Admin | Bấm *Sao chép lệnh sửa*, rồi dán vào PowerShell chạy bằng quyền Administrator |
| macOS | Thường không cần làm gì | Nếu app thuộc tài khoản khác: *Sao chép lệnh sửa* (sudo) |
| Linux (.deb/.rpm) | Thư mục thuộc quyền root | *Sao chép lệnh sửa* (sudo) |
| Linux Snap / Flatpak | Hệ thống file chỉ-đọc | Không hỗ trợ. Hãy dùng bản .deb/.rpm/.tar.gz |

## Giới hạn đã biết

- Các panel do IDE vẽ bằng webview riêng (ví dụ panel Agent của Antigravity) giữ nguyên nền của chúng ở chế độ *Xuyên khung*.
- Ở chế độ *Xuyên khung*, terminal chỉ trong suốt khi tắt GPU cho terminal. Extension sẽ hỏi bạn 1 lần.
- GIF nhỏ (dưới ~900×500) giữ nguyên dạng GIF lại nhẹ CPU hơn video (đã đo). GIF độ phân giải lớn được đánh dấu ⚡: chuyển sang MP4 giúp giảm khoảng 35% CPU.

## Cấu hình

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `wallpaperStudio.libraryPath` | (tự chọn, xem trên) | Thư mục thư viện ảnh |
| `wallpaperStudio.ffmpegPath` | (tự tìm) | Đường dẫn ffmpeg |
| `wallpaperStudio.statusBar` | `true` | Hiện nút trên thanh trạng thái |
| `wallpaperStudio.autoRepair` | `true` | Hỏi cài lại khi IDE cập nhật |

## Riêng tư

Không thu thập hay gửi dữ liệu nào. Mạng chỉ được dùng khi bạn chủ động *Thêm từ URL*.

## Đóng góp / báo lỗi

https://github.com/hm4uc/live-wallpaper-studio/issues

## Giấy phép

MIT
