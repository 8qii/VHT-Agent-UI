# VHT Agent UI

UI chat tiếng Việt dùng chung public API của **VHT-Agent-Backend** và **VHT-Agent-Backend-DSH**. Chạy độc lập; không cần cài dependency, build frontend hoặc thay backend.

## Chạy nhanh

Yêu cầu Node.js 22+. Trong workspace hiện tại `start.sh` tự tìm Node đi kèm Codex nếu Node chưa có trong PATH.

```bash
git clone https://github.com/8qii/VHT-Agent-UI.git
cd VHT-Agent-UI
cp .env.example .env
./start.sh
```

Nếu đã có source, chỉ cần vào thư mục `VHT-Agent-UI` và chạy `./start.sh`.

Mở **http://127.0.0.1:5173**. Nếu có Node trong PATH, có thể dùng `npm start` hoặc `npm run dev` (watch server).

Backend và agent cần được chạy bằng launcher của stack tương ứng. UI không tự khởi động runtime, đổi LLM, sửa `.vht/development.env` hay thực hiện migration.

Hai launcher hiện tại cùng dùng `5062`. Vì vậy `.env.example` để cả hai URL ở `http://127.0.0.1:5062`. Lựa chọn trong UI chỉ đổi endpoint client; **không đổi runtime đang phục vụ cổng đó**. Nếu muốn kết nối hai stack đồng thời, cho chúng dùng cổng khác nhau rồi cấu hình:

```dotenv
VHT_BACKEND_URL=http://127.0.0.1:5062
VHT_DSH_BACKEND_URL=http://127.0.0.1:5063
HOST=127.0.0.1
PORT=5173
```

Sau khi đổi `.env`, khởi động lại UI. URL cũng có thể có deployment path prefix. Không đặt credentials trong URL.

## Sử dụng

- Nhấn nút backend ở góc phải để chọn stack và xác thực.
- Development: nhập `X-Demo-User`; mặc định là user ID `00000000-0000-0000-0000-000000000001`. Backend phải bật cơ chế demo header và cấp quyền cho user đó.
- Bearer: token chỉ giữ trong bộ nhớ của tab, không ghi localStorage hoặc URL. Khi tải lại, nhập token để khôi phục lịch sử đúng tài khoản.
- Cookie: gửi `credentials: include`. Lịch sử chỉ giữ trong tab vì UI không biết danh tính cookie để phân vùng dữ liệu local. Cookie của origin backend khác không tự chuyển sang origin proxy; dùng kết nối trực tiếp/deployment cùng origin thích hợp và kiểm tra auth thật.
- Nhập tin nhắn, **Enter** gửi, **Shift+Enter** xuống dòng; **Ctrl+K / ⌘K** mở chat mới.
- Mọi câu hỏi dùng cùng chat flow, không chọn capability hay phân loại prompt.
- Lịch sử local cho demo/bearer tách theo endpoint, backend, mode và fingerprint danh tính. Reload khôi phục run đang chạy bằng GET; không POST prompt lại.
- Lần gửi bị mất receipt có nút **Thử lại lần gửi này**, giữ session và idempotency key. Pending submission được lưu trước POST.
- **Dừng** gửi cancellation API thật; đóng tab hoặc ngắt stream không hủy run.
- **Events** ở thanh trên mở lịch sử public SSE của câu trả lời hiện tại: snapshot, assistant.text, agent.progress, run.terminal. Nhấn từng event để xem field công khai và text fragment; nhãn cạnh VHT Agent phân biệt SSE trực tiếp, reconnect, polling và đã kết thúc. Run đã xong vẫn giữ events nhận được ở UI, kể cả sau reload; tối đa 200 event/run, text preview tối đa 1.000 ký tự/event. **Đọc snapshot SSE** chỉ GET run cũ, không POST prompt, không replay các token chưa được ghi nhận.
- Proposal hiển thị candidate/rollback/diff. Chỉ hiện approve/reject/revise khi canonical response trả đúng action contract cho run hiện tại. Duyệt cần thao tác xác nhận và có thể kích hoạt TRY/CREATE theo backend. UI không tự thực hiện hành động hoặc tự retry mutation khi mất receipt.
- Báo cáo tải bằng authenticated fetch từ artifact endpoint; lỗi 409/410/404 hiển thị rõ, không giả file thành công.

## API và các điểm sửa so với tài liệu Word

Tài liệu `docs/tích hợp FE.docx` được dùng làm tham khảo và giữ nguyên. Implementation đối chiếu với `Application/AssistantContracts.cs`, `Application/AgentChatStream.cs`, `Program.cs` và `docs/general-agent-fe-integration.md` ở cả hai backend.

| Nội dung | Contract trong UI |
|---|---|
| Tạo session | POST `/api/chat/sessions`, body chỉ `{title}`; lấy `id` |
| Gửi prompt | POST `/api/chat/sessions/{id}/prompts`, `{text,idempotencyKey}`; accepted DTO dùng **`id` làm runId**, không có `runId` riêng |
| REST status | Numeric enum 0–10; normalize thành tên lifecycle |
| SSE | `version:2`, status dạng string, event `snapshot/assistant.text/agent.progress/run.terminal` |
| Progress | **`activityState`**, không phải `state` |
| Snapshot | Replace draft bằng `text ?? ''`; terminal snapshot hydrate ngay |
| Kết thúc | GET run để xác định lifecycle, GET `/response` để replace canonical text và blocks |
| Status không terminal | Pending, Running, Uncertain, WaitingConfirmation, Executing |
| Presentation v1 | reportSummary, metricCard, table, chart, artifact, evidenceCollection, configProposal |
| Cấu hình | Actions allowlist theo canonical `id/method/url`, không suy từ prose |

SSE parser đọc UTF-8 incremental, CR/LF/CRLF, comment heartbeat và multiline data. Sequence được reset mỗi connection. Reconnect cùng run, exponential backoff; sau stream lỗi lặp/contract không hỗ trợ chuyển sang polling. Watchdog kiểm tra lifecycle mỗi 10 giây ngay cả khi stream còn mở; fallback mỗi 3 giây. Terminal hydration lỗi chỉ retry GET.

Markdown dùng **marked 17.0.5** + **DOMPurify 3.3.0**, vendored trong `public/vendor` cùng license, không cần CDN khi sử dụng. Render public content riêng với progress/evidence. Unknown blocks bị bỏ qua; không gọi provenance hoặc stringify payload nội bộ. BAR không âm hiển thị bar; dạng chart khác hiển thị bảng giá trị để giữ ý nghĩa dữ liệu. Table giới hạn 200 dòng, evidence card 25 records, chart 100 categories và ghi rõ giới hạn hiển thị.

UI cũng chạy trên HTTP qua IP máy chủ: UUID dùng `crypto.getRandomValues` khi `randomUUID` không có; fingerprint danh tính dùng **js-sha256 0.11.1** (MIT, vendored) khi `crypto.subtle` không có. Các scope lịch sử vẫn dùng cùng SHA-256 trên HTTP/HTTPS.

## Proxy và triển khai

Node proxy local `/backend/{goose|dsh}/api/chat/...` chuyển stream và auth tới URL cố định từ env, không nhận arbitrary target từ browser. Auth header/cookie được chuyển tiếp, secrets không log, dữ liệu chat không được cache. Mặc định server chỉ lắng nghe `127.0.0.1`.

Proxy giúp chạy nhanh local và **không chứng minh production CORS/IAM**. Để kiểm tra CORS thật, nhập backend URL trong phần kết nối trực tiếp. Không dùng `no-cors`. Production cần reverse proxy/TLS/auth/CORS theo deployment, xác minh cookie/owner isolation và bảo vệ quyền truy cập proxy nếu mở ra mạng.

## Kiểm chứng

```bash
node --test test/*.test.js
```

`test/browser-smoke.mjs` dùng Playwright nếu được cài, hoặc biến `PLAYWRIGHT_MODULE` trỏ tới module có sẵn. Nó chạy API fixture độc lập trên cổng ngẫu nhiên; không gọi agent, LLM hoặc endpoint thực thi thật.

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/browser-smoke.mjs
```

Kết quả chi tiết và giới hạn live ở `VERIFICATION.md`.

## Chạy trên máy chủ với systemd user

Đặt source ở `~/VNC/VHT-Agent-UI`. Cần Node22+ trong PATH hoặc tại `~/.local/share/vht-node/current/bin/node` (cài bản chính thức từ nodejs.org và kiểm tra SHASUMS256).

Ví dụ backend đang chạy cùng máy ở cổng5062, UI mở cổng5173:

```dotenv
VHT_BACKEND_URL=http://127.0.0.1:5062
VHT_DSH_BACKEND_URL=http://127.0.0.1:5062
HOST=0.0.0.0
PORT=5173
```

Ghi các dòng trên vào `.env`, rồi chạy:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/vht-agent-ui.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vht-agent-ui.service
loginctl enable-linger "$USER"
```

UI tự chạy lại khi tiến trình dừng và khởi động cùng user manager sau reboot. Linger giữ service hoạt động khi đăng xuất; một số máy cần admin bật tùy chính sách.

```bash
systemctl --user status vht-agent-ui.service
journalctl --user -u vht-agent-ui.service -n 50 --no-pager
systemctl --user restart vht-agent-ui.service
```

Mở `http://<server-ip>:5173`. UI proxy tới backend nội bộ và sử dụng auth đang được backend cấu hình. UUID/history có fallback cho HTTP qua IP. Với deployment Internet, cấu hình reverse proxy HTTPS và cơ chế auth tương ứng.
