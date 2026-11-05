# Device Config V3 trong VHT-Agent-UI

Đã ghép UI với contract Backend/Agent local ngày 04/11/2026. Source contract: `VHT-Agent-Backend-DSH/docs/device-config-direct-pair-review.vi.md` trong cùng workspace. Đây là hướng dẫn implementation, không thay contract Backend.

## Sử dụng

Lời giải thích của Agent nằm trong chat. Card **Device Config · revision N** đọc từ snapshot Backend, có config và rollback của từng thiết bị.

1. Bấm **✎ Sửa config** hoặc **✎ Sửa rollback**. Nội dung đang soạn chỉ nằm trong bộ nhớ tab. Config thay đổi riêng sẽ nhắc xem lại rollback.
2. **Lưu cặp** gửi đầy đủ deploy/rollback của thiết bị đó. **Lưu tất cả** gửi các cặp thay đổi trong một request. Backend tạo revision trực tiếp, không chạy Agent. Không trim CLI; CRLF được Backend chuẩn hóa thành LF.
3. **Try cặp này** hoặc **Try tất cả** chỉ dùng các cặp đã lưu. Khi còn bất kỳ cặp chưa lưu, Try/Accept bị khóa để không thử nhầm bản cũ.
4. **Accept · TRY và tạo Draft** gửi một command. Backend TRY lại toàn bộ rồi CREATE một Config Setup Draft nếu tất cả đạt. UI không nối chuỗi TRY/CREATE bằng nhiều request, không gửi prompt để thực thi.
5. **Yêu cầu AI sửa bản cấu hình này** là tùy chọn riêng, gửi instruction gắn chính xác proposal đang xem. NoRevision giữ card hiện có và hiển thị lời trả lời. Chat thông thường có thể tiếp tục sau khi review không còn tác vụ hoặc chỉnh sửa chưa lưu.

Rollback rỗng vẫn lưu được; Backend chiếu incomplete và khóa Try/Accept tương ứng. Try thành công không xác nhận rollback đã được kiểm chứng riêng vì upstream chưa cung cấp verdict đó.

## API thực tế

| Nút / luồng | Request |
|---|---|
| Lưu cặp / Lưu tất cả | `POST /api/chat/runs/{card.runId}/revisions`, mode content, full-pair changes |
| Try | `POST /api/chat/runs/{card.runId}/try`, deviceIds; không gửi CLI |
| Accept | `POST /api/chat/runs/{card.runId}/approve`; không gửi deviceIds/CLI |
| Yêu cầu AI sửa | `POST /api/chat/runs/{card.runId}/revisions`, mode instruction và text |
| Tiến trình | `GET /api/chat/config-operations/{operationId}` |
| Bản hiện hành / 20 revision gần nhất | `GET /api/chat/config-workflows/{workflowId}?offset=0&limit=20` |
| Lời trả lời gốc / NoRevision | `GET /api/chat/runs/{runId}/response` |
| Đối soát CREATE Unknown | `POST /api/chat/runs/{card.runId}/config-setup/reconcile` |

Mọi mutation gắn `proposalId`, `expectedRevision`, `expectedCandidateHash`, `expectedReviewVersion` và một idempotencyKey. URL được dựng từ ID, không thực thi URL lấy từ lời văn hoặc operationUrl tùy ý. Proxy và owner authentication hiện có được dùng nguyên trạng.

Card V2 được đọc và Accept theo CAS cũ; nếu server chưa có workflow/history endpoint thì đọc canonical response. Editor full-pair/Try riêng chỉ bật ở V3. V1 giữ renderer/actions cũ. Không tự nâng version, đổi flag Backend hoặc chuyển V2 thành V3.

`workflow.current` là DTO ConfigProposalBlock cụ thể nên JSON có thể không có discriminator `kind`; khác với phần tử trong `response.presentationBlocks`. UI chỉ gắn nhãn configProposal ở ngữ cảnh endpoint workflow đã biết, rồi kiểm đầy đủ workflow/reference/version/hash/capability. Không suy hay bổ sung các quyền/tham chiếu còn thiếu. Nút **Làm mới trạng thái** luôn có phản hồi thời điểm cập nhật; bản không đổi vẫn được xác nhận đã tải. **Lưu tất cả** chỉ bật khi có chỉnh sửa, có mô tả lý do khi tắt.

## Lỗi và phục hồi

- 400/409/413/429 giữ nguyên editor. 409 yêu cầu đọc lại bản Backend; nếu có head mới, giữ draft cũ để đối chiếu. Chỉ **Dùng bản mới và bỏ chỉnh sửa** mới bỏ buffer. Không tự rebase hay Accept head mới.
- Mất HTTP receipt giữ request/key trong bộ nhớ. **Lấy lại biên nhận lần gửi** gửi lại đúng command để lấy receipt đã persist. Không có POST retry tự động. Try/Accept giữ refs/key/selection qua reload; request khôi phục được kiểm allowlist.
- Request Save chứa CLI nên không được đưa vào localStorage. Reload khi mất Save receipt chỉ đọc lại Backend và nhắc kiểm tra; trong cùng tab vẫn có thể replay frozen Save. beforeunload nhắc khi còn draft/lần Save chưa rõ kết quả.
- Polling độc lập stream generation. Reload/chuyển chat chỉ dừng các GET observer; operation Backend vẫn chạy. Ref operation được lưu trước POST/tiếp tục GET. Thay Backend/tài khoản xóa private controllers/buffers.
- Known pre-CREATE failure cho phép người dùng Accept lại cùng revision với refs mới và key mới. Không Save no-op để ép revision mới.
- OutcomeUnknown khóa mutation mới. CREATE_OUTCOME_UNKNOWN có nút đối soát, không CREATE lại. TRY_OUTCOME_UNKNOWN cần người vận hành kiểm candidate/cleanup; không có nút bỏ qua Unknown.

UI hiển thị progress, diagnostic, baseline checkedAt/freshness và kết quả riêng theo target. Freshness Unknown giữ nguyên. Kết quả cũ của pair đã thay đổi hiển thị Stale. Card cũ trong cuộc trò chuyện không được thao tác khi có card mới hơn cùng workflow hoặc lượt chat đang chạy.

## Storage và nhiều thiết bị

Backend là nơi lưu các cặp/revision. LocalStorage của review chỉ giữ refs và idempotency metadata không chứa CLI. Saved card, diff, text/event của response có config được loại khỏi cache và hydrate qua authenticated GET sau reload. Editor buffers giữ được khi chuyển chat trong cùng scope của tab; không được lưu bền qua reload.

Với nhiều target, card đóng sẵn khi có hơn ba thiết bị; có bộ lọc đang sửa/lỗi. Requested targets chưa có candidate hoặc unchanged vẫn có dòng trạng thái. Danh sách revision hiện giới hạn 20 và thông báo giới hạn; chưa có trang quản lý workflow hay diff giữa hai revision.

## Kiểm chứng và rollout

`npm test` chạy unit/contract tests. `npm run test:browser` chạy browser regression có sẵn. `npm run test:device-config` chạy các journey Device Config với HTTP fixture sau proxy thật. Hai browser scripts cần Playwright hoặc biến `PLAYWRIGHT_MODULE` trỏ đến module có sẵn; không tự cài thêm dependency.

Backend cần migration `20261104084505_AddDirectConfigPairReview` và các flag mới, gồm `DirectPairReviewEnabled`, trước khi phát card V3. UI tự đọc phiên bản/capability mà Backend trả. Thay đổi UI này không bật flag, migrate, commit/push hay deploy service.

Qualification trong batch là browser + API contract fixture; chưa phải E2E với Backend PostgreSQL/Agent/customer TRY thật hoặc nghiệm thu rollback semantics trên phần cứng. Không có model/provider request hay TRY/CREATE thật từ browser tests.
