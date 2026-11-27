# Family Organizer trên Oracle Cloud VPS

Cấu hình này dùng Docker Engine và Compose trên Ubuntu VPS. Docker build từ mã nguồn của fork theo kiến trúc của VPS, gồm Ampere ARM64 (`aarch64`) và x86-64 (`x86_64`). Tài khoản Linux `family` sở hữu repo và dữ liệu. Tiến trình trong container chạy với cùng UID/GID. Tài khoản quản trị VPS chạy các lệnh Docker qua `sudo`.

## Cài lần đầu

Kết nối VPS bằng tài khoản quản trị. Trên Ubuntu OCI, tài khoản mặc định là `ubuntu`. Có thể dùng `ssh vps-oracle` nếu máy đã có alias. Nếu VPS chưa có Docker và Compose, cài theo [hướng dẫn Docker Engine cho Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

Trên VPS, tạo tài khoản và clone repo một lần.

```bash
getent passwd family >/dev/null || sudo adduser --disabled-password --gecos '' family
sudo -u family -H git clone https://github.com/tanka420/Family-Organizer.git /home/family/Family-Organizer
```

Nếu `compose.oracle.yml` và `.dockerignore` đang nằm ở bản làm việc trên máy bạn, chép chúng sang VPS trước khi build. Chạy các lệnh PowerShell dưới đây tại thư mục repo với alias SSH của tài khoản quản trị.

```powershell
$staging = ssh vps-oracle 'mktemp -d /tmp/family-oci.XXXXXXXX'
scp .\compose.oracle.yml .\.dockerignore "vps-oracle:${staging}/"
ssh vps-oracle "sudo install -o family -g family -m 0644 '$staging/compose.oracle.yml' '$staging/.dockerignore' /home/family/Family-Organizer/"
```

Trên VPS, tạo thư mục dữ liệu và cấu hình UID/GID. Lệnh tạo `.env` chỉ dùng khi cài mới. Nếu file đã có, giữ cấu hình hiện tại và bổ sung `FAMILY_UID` và `FAMILY_GID` theo kết quả `id family`.

```bash
sudo -u family -H bash <<'BASH'
set -eu
cd /home/family/Family-Organizer
install -d -m 0700 data
umask 077
set -o noclobber
printf 'FAMILY_UID=%s\nFAMILY_GID=%s\n' "$(id -u)" "$(id -g)" > .env
BASH

sudo docker compose --env-file /home/family/Family-Organizer/.env \
  -f /home/family/Family-Organizer/compose.oracle.yml up -d --build --wait
curl --fail --silent --show-error http://127.0.0.1:3001/api/health
```

Nếu cổng `3001` đã được dùng, đặt `FAMILY_HTTP_PORT=3002` trong `.env` và thay cổng VPS trong các lệnh bên dưới. Gemini và Web Push có thể cấu hình sau.

## Truy cập và thiết lập tài khoản admin

Từ máy cá nhân, mở SSH tunnel và giữ phiên này trong lúc dùng app.

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3001:127.0.0.1:3001 vps-oracle
```

Mở `http://127.0.0.1:3001` và đăng nhập web bằng `admin`. Với lần tự cài mới trên một cơ sở dữ liệu trống, mật khẩu ban đầu là `admin123`. Đổi mật khẩu trong **Thiết lập → Hồ sơ cá nhân → Đổi mật khẩu**. Tài khoản Linux `family` dùng để quản lý dự án qua SSH.

Với bản đã triển khai trên `vps-oracle`, mật khẩu `admin` đã được đổi sang mật khẩu ngẫu nhiên. Đọc mật khẩu bằng lệnh sau từ máy cá nhân.

```bash
ssh vps-oracle 'sudo -u family cat /home/family/.family-organizer-admin-password'
```

Để gia đình truy cập từ điện thoại qua HTTPS, có thể dùng [Tailscale Serve](https://tailscale.com/docs/solutions/host-private-server-docker) trỏ tới `http://127.0.0.1:3001` sau khi đổi mật khẩu. Cả SSH tunnel và Tailscale Serve đều giữ cổng ứng dụng trong VPS. Cấu hình OCI chỉ cần cho phép SSH từ IP quản trị nếu dùng tunnel. [Quy tắc mạng OCI](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/configuration_tasks.htm)

### HTTPS qua FlashPanel trên `vps-oracle`

Site `family.thanhtan.top` dùng reverse proxy cổng `3001`. FlashPanel phục vụ tệp xác minh Let's Encrypt từ `/home/family/.ssl`. Nếu Nginx báo `Permission denied` ở đường dẫn này, kiểm tra quyền đi qua `/home/family` của user chạy Nginx. Trên `vps-oracle`, user đó là `flashpanel`.

```bash
sudo setfacl -m u:flashpanel:--x /home/family
```

Sau đó vào **SSL → Gia hạn và kích hoạt** trên chứng chỉ của `family.thanhtan.top`. Kiểm tra lại qua `https://family.thanhtan.top/api/health`. [Hướng dẫn xử lý lỗi SSL 403 của FlashPanel](https://flashpanel.io/docs/v2/vi/site/ssl.html#invalid-response-403)

## Vận hành

Trong app, dùng **Thiết lập → Hệ thống & Sao lưu → Tải backup toàn phần (.zip)** và lưu bản sao ngoài VPS. SQLite, tệp tải lên và khóa phiên của app nằm trong `/home/family/Family-Organizer/data/`. Nếu sao lưu trực tiếp thư mục dữ liệu, dừng container trước khi sao chép để giữ snapshot SQLite nhất quán.

### Cập nhật trong ứng dụng

Sau khi app chạy ổn, cài dịch vụ một lần từ bản checkout đã kiểm tra của fork bằng `sudo bash deploy/install-oci-updater.sh`. Dịch vụ chạy qua systemd và xử lý yêu cầu từ **Thiết lập → Hệ thống & Sao lưu → Phiên bản & Cập nhật**.

Dịch vụ build tag đã phát hành ở `tanka420/Family-Organizer` ngay trên VPS. Nó giữ bản sao SQLite và tự quay về phiên bản trước nếu bản mới không qua health check. `journalctl -u family-organizer-updater` hiển thị log chi tiết. Cấu hình Docker của dịch vụ nằm ở `/etc/family-organizer` và cần được cập nhật ở đó khi thay đổi `.env` hay Compose.

### Bật nhận thông báo BIDV SmartBanking

Trên VPS, đặt `BIDV_IMPORT_TOKEN` riêng cho bản thật trong `/etc/family-organizer/app.env` nếu dùng updater, hoặc `/home/family/Family-Organizer/.env` nếu dùng Compose thủ công. Khi bật lần đầu cho một hệ thống đã có updater, cập nhật Compose của updater từ checkout đã kiểm tra bằng `sudo bash deploy/install-oci-updater.sh`. Áp dụng cấu hình bằng quy trình cập nhật ứng dụng hoặc chạy lại Compose để tạo lại container.

Chỉ đổi URL của Phím tắt sang `https://family.thanhtan.top/api/finance/imports/bidv` sau khi xác nhận bản thật đã lên phiên bản mới và endpoint trả `401` khi gửi POST thiếu token. Dùng token của bản thật trong Phím tắt.

### Bật nhận thông báo tài khoản MyVIB

Đặt `MYVIB_IMPORT_TOKEN` riêng cho MyVIB trong cùng tệp môi trường. Cập nhật Compose của bản cài và tạo lại container để biến mới có hiệu lực. Tạo tự động hóa riêng cho thông báo MyVIB trên iPhone. Dùng `POST https://family.thanhtan.top/api/finance/imports/myvib`, header `Authorization: Bearer <token MyVIB>` và bốn trường JSON dạng văn bản: `eventId`, `receivedAt` (ISO 8601 có múi giờ), `title` và `body`.

Chọn **Chi tiêu → MyVIB** bằng tài khoản Admin để duyệt thông báo tài khoản. Đánh dấu **Chuyển nội bộ** nếu khoản chuyển là giữa các tài khoản của bạn. Thông báo có nhãn thẻ tín dụng được bỏ qua. Có thể gửi lại cùng `eventId` khi thử lại cùng một thông báo.

### Vận hành thủ công

Vào tài khoản quản lý bằng `sudo -iu family` để thao tác với repo và dữ liệu. Với bản cài chưa có dịch vụ cập nhật, dùng các lệnh dưới đây để cập nhật qua terminal từ tài khoản quản trị VPS.

```bash
sudo -u family -H git -C /home/family/Family-Organizer pull --ff-only
sudo docker compose --env-file /home/family/Family-Organizer/.env \
  -f /home/family/Family-Organizer/compose.oracle.yml up -d --build --wait
sudo docker compose --env-file /home/family/Family-Organizer/.env \
  -f /home/family/Family-Organizer/compose.oracle.yml ps
sudo docker compose --env-file /home/family/Family-Organizer/.env \
  -f /home/family/Family-Organizer/compose.oracle.yml logs --tail 100
```
