# Data Relay

现场设备通过 TCP 或 UDP 主动上传 `@...#` 文本报文。服务解析并持久化原始帧，再异步调用 KingHistorian RESTful 接口写入已配置点位。

## 当前能力

- 可配置为仅 TCP、仅 UDP 或 TCP + UDP；双协议可同时使用同一数字端口
- TCP 半包、粘包、多帧和垃圾前缀处理，UDP 数据报边界、大小限制和异常报文处理
- 兼容单值帧与 `D/T` 控制的 `|` 分隔批量历史帧，自动展开独立历史时间
- 设备自动发现、字段显式映射和倍率换算
- SQLite WAL 原始报文、可靠队列、快速重试、低频持续重试和去重
- KH 客户端注册、变量同步、建点和历史数据写入
- 单管理员设备管理、转发配置和日志查询后台
- 可在构建时选择授权版或免授权版；授权版支持机器码绑定、有效期和动态设备数限制
- PM2 单实例守护、优雅退出和日志大小维护
- 携带 Node.js、PM2 和全部依赖的离线交付包构建

## 开发运行

版本使用 `0.3.4` 这样的三段格式。每批交付修改递增版本，并同步 `package.json` 与 `package-lock.json`；构建产物自动沿用该版本，不能仅改旧ZIP文件名。具体开发约定见 `AGENTS.md`。

Git仓库保存全部程序源码、测试和构建脚本。大体积的字体、已生成Word手册和第三方Windows可执行文件作为构建资源独立保存，不进入Git历史。首次从Git克隆后，在运行Windows构建或全量测试前，将 `data-relay-build-assets-0.3.5.zip` 解压到项目根目录，补齐以下资源（已有完整构建源包也包含这些文件）：

- `assets/fonts/NotoSansCJKsc-Regular.otf`
- `docs/Data Relay 数据转存系统配置操作指南.docx`
- `vendor/winsw/WinSW-x64.exe`

WinSW还可以按 `vendor/winsw/README.md` 中的官方地址和SHA-256恢复；构建过程仍校验该文件哈希。已有完整工作区不需要重复补齐。

```bash
npm install
cp .env.example .env
ADMIN_PASSWORD=your-password SESSION_SECRET=replace-with-random-secret npm start
```

默认管理后台为 `http://127.0.0.1:8080`，设备接入端口为 `9000`，新安装默认选择“仅 TCP”，可在转发配置中切换为“仅 UDP”或“TCP + UDP”。管理员账号为 `admin`，未配置时默认密码为 `Administrator`；现场首次登录后建议通过环境变量修改。

授权版首次启动后在“软件授权”页面复制机器码，使用内部激活码生成工具签发带设备数量和有效期的 `.lic` 文件，再回到后台导入。未激活或授权异常时仍保存已配置设备的接入报文，但不向 KH 转存。免授权版不显示授权页，对设备数量和有效期不作限制。

发送模拟报文：

```bash
node tools/tcp-simulator.js 127.0.0.1 9000 normal
node tools/tcp-simulator.js 127.0.0.1 9000 split
node tools/tcp-simulator.js 127.0.0.1 9000 sticky
node tools/tcp-simulator.js 127.0.0.1 9000 batch
```

模拟 10 台设备分别建立 TCP 长连接、每 5 秒上报一次并持续 60 秒：

```bash
node tools/tcp-device-fleet.js 127.0.0.1 9000 10 5000 60
```

参数顺序为 `服务器IP TCP端口 设备数 上报间隔毫秒 运行秒数 报文模式`。报文模式可选 `single`（默认）或 `batch`；运行秒数设置为 `0` 时持续运行，按 `Ctrl+C` 停止。每台设备使用不同的 STC、SN、IMEI 和动态测量值。

模拟10台设备持续发送批量历史帧：

```bash
node tools/tcp-device-fleet.js 127.0.0.1 9000 10 5000 60 batch
```

用独立现场批量帧模拟器模拟3台设备，每帧8个样本、间隔30分钟，每5秒上报并运行60秒：

```bash
node tools/tcp-batch-simulator.js 127.0.0.1 9000 3 5000 60 8 30 true tcp
node tools/tcp-batch-simulator.js 127.0.0.1 9000 3 5000 60 8 30 true udp
```

参数依次为 `服务器IP 接入端口 设备数 上报间隔毫秒 运行秒数 每帧样本数 样本间隔分钟 是否打印报文 传输方式`。它按现场字段顺序生成 `A01/A02/P01/P02` 竖线分隔数据，并动态生成 TM、LEN、序号和 XOR8 校验值。倒数第二个参数控制报文打印；最后一个参数可传 `tcp`、`udp` 或 `both`。Windows 交付包可直接运行 `simulate-batch.cmd`。

Windows 包同时提供三个固定协议的一键入口：`simulate-tcp.cmd`、`simulate-udp.cmd`、`simulate-tcp-udp.cmd`。双协议模拟时，奇数编号设备使用 TCP，偶数编号设备使用 UDP，每台设备的 STC 保持唯一。

300连接渐进并发测试可使用两个进程，避免测试客户端自身的文件句柄限制：

```bash
node tools/connection-load.js 127.0.0.1 9000 150 5000 0 10
node tools/connection-load.js 127.0.0.1 9000 150 5000 150 10
```

若要求数百台设备在同一瞬间重连，Linux 还需同步调大 `net.core.somaxconn`；这与稳定保持300条TCP连接是两个不同的容量指标。

## 测试

```bash
npm test
npm run test:performance
```

性能测试默认在独立临时数据库中模拟 300 台设备、每 5 秒上报、每帧 6 个 KH 点并持续 60 秒，不会写入正式数据目录或真实 KH。它会校验网络接收、SQLite 落盘、KH 模拟写入和最终队列数量完全一致，并输出 CPU、内存、事件循环延迟和磁盘占用。通过 `--transport tcp|udp` 选择接入协议；macOS/Linux 执行 300 个 TCP 客户端同进程压测前建议先运行 `ulimit -n 65535`。

模拟现场每帧 4 个字段、每字段 8 条历史数据：

```bash
node tools/performance-test.mjs --devices 300 --duration-seconds 60 --interval-ms 5000 \
  --mappings 4 --samples 8 --sample-interval-minutes 30 --batch-size 100

node tools/performance-test.mjs --transport udp --devices 300 --duration-seconds 60 --interval-ms 5000 \
  --mappings 4 --samples 10 --sample-interval-minutes 30 --batch-size 100
```

## 内部激活码生成工具

生成工具位于 `internal-tools/`，只供软件供应方内部使用，不会进入客户离线交付包。正式私钥和口令必须保存在项目目录之外。

日常使用推荐双击 Windows 下的 `internal-tools/start-license-tool.cmd`，工具会只在 `127.0.0.1` 启动并自动打开本地签发页面。页面支持客户与项目、机器码、设备上限、生效/到期日期、常用有效期、私钥口令、备注、`.lic` 下载和签发历史查询；口令只参与当次签名，不写入磁盘。第一次使用可单独运行 `internal-tools/initialize-license-keys.cmd`，初始化后必须将口令文件移至独立安全位置，并把生成的公钥配置复制到产品 `config/` 后重新构建客户包。

macOS 本机可运行 `internal-tools/start-license-tool.sh`。默认读取项目同级的 `DataMigration-LicenseAuthority` 安全目录，不会把私钥复制进源码工作区。

在 Windows 上构建独立的内部签发工具包：

```bat
build-license-tool-windows.cmd
```

输出为 `releases/data-relay-license-tool-<版本>-win32-x64.zip`。该包包含 Node.js 运行时和所需依赖，但初始不包含正式私钥；私钥、口令和生成器绝不能放入客户交付包。

首次创建签名密钥：

```bash
node internal-tools/license-generator.mjs keygen \
  --output /安全目录/DataMigration-LicenseAuthority \
  --key-id prod-2026-01 \
  --create-passphrase-file true
```

将生成的 `license-public-keys.json` 放入项目 `config/` 后重新构建客户交付包。签发授权：

```bash
LICENSE_KEY_PASSPHRASE_FILE=/安全目录/DataMigration-LicenseAuthority/PRIVATE_KEY_PASSPHRASE.txt \
node internal-tools/license-generator.mjs generate \
  --private-key /安全目录/DataMigration-LicenseAuthority/prod-2026-01.private.pem \
  --key-id prod-2026-01 \
  --customer "客户名称" \
  --project "项目名称" \
  --machine-code "DRM-..." \
  --max-devices 300 \
  --valid-from 2026-10-01 \
  --valid-until 2027-10-01 \
  --output /安全目录/DataMigration-LicenseAuthority/licenses
```

完整规则见 [激活码功能设计](docs/激活码功能设计.md)。

## 离线交付包

在与现场相同的操作系统和 CPU 架构上执行：

```bash
npm run package:offline
```

首先在 `packaging/build-variants.json` 中设置 `licenseRequired`：`true` 构建授权版，`false` 构建免授权版。默认同时输出两个目录，均位于 `releases/`：

- `*-source`：现场调试包。服务端业务代码保留源码，能够使用 VSCode 启动和断点调试；激活码核心仍为 JSC，不包含授权核心源码。
- `*-jsc`：正式保护包。服务端业务代码及设备模拟工具全部编译为 JSC，只保留启动 JSC 所必需的极小 `.cjs` 加载器。

两个包都包含锁定版本的 Node.js 执行程序、PM2、生产依赖、应用代码、启动脚本和 SHA-256 文件校验清单；仅授权版包含授权公钥。现场不需要安装 Node.js、npm 或 PM2，也不需要访问互联网。激活码生成器和签名私钥不会进入任何交付目录。浏览器必须执行 JavaScript，因此管理后台在两种包中均为压缩后的 JS/CSS，而不是 JSC。

开发工作区始终保留完整源码，直接执行 `npm start` 或使用 VSCode 调试时默认加载授权版策略。两个交付包都不会包含 `manager.js`、`codec.js` 和 `machine.js`；构建选定的授权策略会被编译进 `src/license/license-core.jsc` 或整体 `app.jsc`。JSC 与编译它的 Node.js 版本和架构绑定，因此构建程序会把当前 `node` 一起放入交付包，现场必须通过随包启动脚本运行。

如只需单独重建一个版本，可执行 `npm run package:offline -- --variant source` 或 `npm run package:offline -- --variant jsc`。也可用 `--license-required true|false` 临时覆盖构建配置。默认不传参数时按 `packaging/build-variants.json` 构建双包，目录名中会明确包含 `licensed` 或 `unlicensed`。完整规则见 [授权模式构建说明](docs/授权模式构建说明.md)。

Linux/macOS 使用 `start.sh`、`stop.sh`、`restart.sh`、`status.sh`、`logs.sh` 和 `uninstall.sh`。Windows 解压到固定目录后，右键以管理员身份运行 `install-service.cmd`，注册并启动名为 `DataRelay`（显示名称 `Data Relay`）的真正Windows服务，默认自动随系统启动，无需用户登录。随包WinSW启动前台PM2，再由PM2管理单实例程序。运行 `uninstall-service.cmd` 停止并取消服务注册，数据、日志和激活文件保留。详细步骤见 `docs/Windows服务与批量删除说明.md`。

注册后，`start.cmd`、`stop.cmd`、`restart.cmd`、`status.cmd` 自动操作当前目录对应的Windows服务；启停需要管理员权限。未注册时仍可手动使用随包PM2。旧版 `install-autostart-windows.ps1` 和 `uninstall-autostart-windows.ps1` 转调服务注册/取消脚本，安装时会迁移属于当前目录的旧计划任务。Windows服务启动成功只表示管理进程已启动，还需检查管理页面和 `/api/health/ready`。

Windows 现场需要远程排障时，双击 `collect-diagnostics.cmd`。脚本会在 `diagnostics` 目录生成 ZIP，包含异常业务日志、PM2 日志、版本校验文件和基础运行状态；不会收集 `.env`、KH 密码、激活文件、私钥或数据库。诊断日志可能包含设备 STC、远端地址及解析失败帧的前500字符，发送前应按客户数据管理要求确认。

“转发配置 → 日志管理”可设置日志保留天数，默认90天。重复异常按设备或来源限频，KH异常按批次聚合，全部业务日志总量每分钟最多120条；超出数量在下一日志窗口汇总。日志文件按20MB检查阈值或每日轮转，按保留周期自动清理。该限制不影响原始报文和待写任务持久化。

`start.sh` 会将进程文件句柄上限提升到 65535，以支持300台以上设备长连接。Linux 使用 systemd 托管启动脚本时，还应在 service 中配置 `LimitNOFILE=65535`；Windows 不使用此参数。

> `better-sqlite3` 包含平台原生模块，因此 Windows 交付包必须在匹配的 Windows + CPU 架构环境中构建和验证，不能直接复制 macOS 构建结果。

Windows x64 构建机应安装 Node.js 22.14.0 x64，在项目根目录执行：

```powershell
.\build-windows.cmd
```

脚本会依次执行平台和 Node.js 版本检查、`npm ci`、自动化测试、双版本构建、结构与源码泄漏检查，以及两个 ZIP 的压缩。构建机需要联网下载锁定依赖；生成的 `*-source.zip` 和 `*-jsc.zip` 才是带到现场内网的文件。若 `better-sqlite3` 没有匹配的预编译文件导致 `npm ci` 失败，应安装 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”以及 Python 后重试。

可以直接双击 `build-windows.cmd`。构建窗口无论成功或失败都会停留并等待按键，完整输出同时保存在项目根目录的 `build-windows.log`。依赖安装会关闭 npm audit 和 funding 请求，避免不支持安全审计接口的 npm 镜像导致构建阶段退出。

`source` 包用于现场联调，`jsc` 包用于正式交付；两者都不会包含授权源码、内部签发工具、私钥或 Source Map。由于 JSC 无法像源码一样直接断点调试，现场排查代码问题时使用 `source` 包，确认无误后再切换为 `jsc` 包。两个包的数据目录格式和配置文件一致，可以在停服并备份后替换程序文件。

## 工作区结构

- `src/`：服务端源码。
- `public/`：管理后台。
- `tools/`：TCP/UDP 模拟和压力测试工具。
- `internal-tools/`：仅供内部使用的激活码生成器。
- `config/`：随产品交付的公钥等配置。
- `docs/source/`：客户提供的原始需求和接口文档。
- `docs/prototype/`：早期交互原型归档。
- `var/test-runs/`：历史本地测试数据库和日志，不进入交付包。
- `releases/`：构建产生的离线交付包。
