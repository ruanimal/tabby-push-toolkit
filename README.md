# tabby-push-toolkit

[简体中文](README.md) | [English](README.en.md)

通过当前已连接的 Tabby 终端会话把常用本地文件推送到目标环境。不限定连接方式，本地或远程会话均可在满足下文环境要求时使用；传输沿用当前终端，不另建文件传输连接。优先使用目标环境已安装的 `trz`；没有可用接收端时，才通过 Base64 引导接收端；优先使用可用的原生解码工具，否则回退到纯 POSIX Shell。

下文中的“远端”指当前终端会话中的目标环境，也可以是本机。

## 功能

- 设置中保存多个常用文件：名称、本地路径、远端目录、目标文件名、执行权限、覆盖策略。
- 已连接的终端右键 → **Push Toolkit** → 选择 **引导传输端** 安装 `trz` 和 `tsz`，或选择常用文件直接上传；操作前需进入目标环境的空闲 Shell 提示符。
- 优先检测配置的远端工具目录中的 `trz`，再查找远端 `PATH` 中的 `trz`。已有接收端时无需配置本地文件、平台或架构，也不要求其实现 `--version`；兼容性由实际传输握手确认。
- 需要引导时，固定从 [trzsz-rs v1.3.0](https://github.com/ruanimal/trzsz-rs/releases/tag/v1.3.0) 下载包含所有平台的压缩包，按远端平台选择内层发行包。Linux 使用静态 musl 构建，优先使用发行包提供的 UPX 版本减小首传体积。
- 校验清单内置在插件中，压缩包缓存在当前 Tabby 配置目录中。支持 GitHub、Gitee 和自定义下载源，支持预下载、打开缓存目录以及手动放入压缩包。按内置 SHA-256 校验后在本机提取 `trz` 和 `tsz`，无需手动选择平台或架构。
- 引导时将 `trz` 和 `tsz` 一起安装到配置的远端工具目录（默认 `~/.local/bin`），并将该目录加入当前终端会话的 `PATH`。先通过 Base64 引导 `trz`，再用协议上传 `tsz`，两者验证成功后才安装。
- 引导每块最多 768 字节，逐块确认序号、累计字节数和校验和。远端 `base64`、`cksum`、`cat` 可用且自检通过时使用原生快速路径，逐块及整文件使用 POSIX `cksum` 校验；否则使用纯 Shell 解码与累计 Adler-32 校验。落盘大小一致并能启动后再替换接收端。
- trzsz 上传到临时目录，客户端协议成功且远端大小一致后再提交文件。默认拒绝覆盖，允许覆盖时使用同一文件系统上的原子重命名。
- 显示阶段与引导进度；右键菜单可查看状态或取消，Ctrl+C 也可取消。传输期间接管输入，避免键盘和文件流混合。

## 安装与依赖

运行依赖中已固定包含 **`tabby-trzsz@1.0.7`**，不需要用户手动安装它。Push Toolkit 显式导入其 Angular 模块，因此即使 npm 把依赖安装到嵌套目录，也能启用其设置和终端装饰器。同一模块被 Tabby 扫描到时由 Angular 去重。

文件上传复用 `tabby-trzsz` 暴露在当前终端上的 `trzsz.uploadFiles()`。工具包在一次操作期间协调它的启动命令和会话流，不另外安装第二套协议引擎。该适配针对 1.0.7，并有实际 npm 发布包的契约及传输测试。

目前为源码实现，尚未发布到 npm。开发加载方式：

```sh
pnpm install
pnpm build
TABBY_PLUGINS=/absolute/path/to/tabby-push-toolkit tabby
```

需完全退出已有 Tabby 进程再启动。`TABBY_PLUGINS` 指向项目目录，与 `tabby-tmux` 的插件结构相同。运行 `pnpm pack` 可生成 `tabby-push-toolkit-0.1.0.tgz` 安装包；在 Tabby 的用户插件目录中通过 npm 安装该包后重启即可，例如：

```sh
npm --prefix /path/to/tabby/plugins install /absolute/path/to/tabby-push-toolkit-0.1.0.tgz --omit=dev --legacy-peer-deps
```

Angular 15、RxJS 7 和 `tabby-core`、`tabby-electron`、`tabby-settings`、`tabby-terminal` 由桌面版 Tabby 提供。

## 首次配置

1. 打开 **设置 → Push Toolkit**，添加常用文件，填写本地绝对路径和远端目录，例如 `~/tools`。远端目录必须以 `/` 或 `~/` 开头；其他 Shell 变量不会展开。目标文件名留空时使用本地文件名。
2. **远端工具目录**默认填写 `~/.local/bin`，留空也使用该目录。可改为 `/usr/local/bin`、`~/tools/bin` 等目录，必须以 `/` 或 `~/` 开头。此设置用于检测和安装 `trz`、`tsz`。
3. 选择接收端下载源，默认 GitHub，备用 Gitee；可添加自定义源。需要提前缓存时点击 **预下载接收端**，无需打开终端会话，也不会保存其他未完成的设置。
4. 保存设置。回到已连接的终端会话，确保当前处于目标环境的空闲 Shell 提示符，右键选择 **Push Toolkit → 引导传输端**，或直接选择常用文件。远端缺少 `trz` 或 `tsz` 时，插件会自动匹配远端平台并下载、缓存、引导安装 `trzsz-rs v1.3.0`。

每次优先检测指定目录下的 `trz`，再检测 `PATH` 中的 `trz`。都不可用时，引导安装到同一目录下的 `trz` 和 `tsz`，目录不存在时自动创建。例如工具目录填 `~/tools/bin`，则优先检测 `~/tools/bin/trz`，需要引导时将两个程序安装到 `~/tools/bin`。每次都会重新检测，不依赖会话缓存。

引导完成后，可在当前会话直接运行 `trz` 上传、`tsz 文件路径` 下载，Tabby 的 trzsz 支持会处理协议。要让新登录会话也直接使用这些命令，请确保登录 Shell 的 `PATH` 包含配置的远端工具目录（默认 `~/.local/bin`）。

## 接收端缓存

缓存位置是 **当前 `config.yaml` 所在目录**下的 `push-toolkit/receivers/v1.3.0/`，设置页会显示实际路径，支持自定义和便携式 Tabby 配置目录。例如 Linux 默认配置目录下：

```text
~/.config/tabby/push-toolkit/receivers/v1.3.0/
├── trzsz-v1.3.0-all-platform.tar.gz
├── trzsz-v1.3.0-x86_64-unknown-linux-musl-upx.tar.gz
├── trzsz-v1.3.0-aarch64-unknown-linux-musl-upx.tar.gz
└── …其他平台压缩包
```

点击设置页的 **打开缓存目录** 会创建并打开此目录。**预下载接收端** 会下载并缓存全平台包（约 36 MB），随后将其中 28 个平台压缩包逐一校验并写入同一缓存目录，无需打开终端会话；支持取消，已有完整有效缓存时直接复用。也可以自行从下面的地址下载，将文件以 `trzsz-v1.3.0-all-platform.tar.gz` 的名称放入缓存目录，之后预下载或首次引导时会自动识别并展开。也可直接放入发行版中对应的平台压缩包，引导时会校验并使用。

内置下载源：

- [GitHub（默认）](https://github.com/ruanimal/trzsz-rs/releases/download/v1.3.0/trzsz-v1.3.0-all-platform.tar.gz)
- [Gitee（备用）](https://gitee.com/iponder/trzsz-rs/releases/download/v1.3.0/trzsz-v1.3.0-all-platform.tar.gz)

设置页可选择优先下载源，或添加名称和完整 HTTP/HTTPS 压缩包地址。先尝试选中的源，网络、HTTP 或校验失败时尝试其余内置源；取消操作不会触发备用下载。自定义源应提供与内置源完全相同的 v1.3.0 全平台包。

全平台包及 28 个内层发行包的 SHA-256 校验值内置在插件中，不再联网下载校验清单，也不信任镜像或缓存目录中的清单。两份内置源的全平台包已核对为相同内容。先校验全平台包，展开后按内置清单校验全部平台包并分别缓存。引导时优先读取已缓存的平台包，只需解压这一层来获取 `trz` 和 `tsz`，无需重新读取或展开全平台包；总包被移走后仍可使用完整的平台缓存。平台包缺失或损坏时，可从缓存的总包重新提取，避免重复下载。手动放入的包也执行相同校验，损坏时重新下载。不同远端平台和预下载可共享一次下载，重启 Tabby 后仍可离线使用已验证的缓存。下载使用 Electron 网络接口，沿用 Tabby 的系统代理配置，支持取消和超时。

压缩包保留在本机配置目录，解压出的 `trz` 在内存中读取，`tsz` 暂存为本地临时文件供协议上传，操作结束后清理；下载的程序不会在本机执行。远端仍不需要 `tar`、`gzip` 或下载工具。自动引导支持该固定发行版提供的 Linux musl 架构和 macOS x86_64/aarch64；不支持的平台会提示先安装兼容的 `trz`。

## 远端要求与限制

远端需要 POSIX `sh`、`mkdir`、`rm`、`mv`、`ln`、`wc`；首次引导额外需要 `chmod` 和 `uname`，赋予上传文件执行权限时需要 `chmod`。自动引导 32 位 MIPS 时还需要 `od` 读取 Shell 的 ELF 端序，优先读取 `/proc/<Shell PID>/exe`，不可用时尝试 `PATH` 中的 Shell 路径和 `/bin/sh`；无法确认端序时会明确失败，不猜测大小端。使用已安装接收端不要求检测平台和架构。BusyBox 可提供这些工具。`stty` 可用时会保存终端状态、关闭回显并在退出时恢复。**不需要** `rz/sz`、`scp`、`sftp`、`base64`、`tar/gzip` 或包管理器。

- 远端目录必须可写且允许执行上传的程序；`noexec` 或执行策略禁止时无法引导。
- 必须在空闲、支持 POSIX 命令引用的 Shell 提示符下操作。全屏程序会被拒绝，但无法可靠检测所有前台程序或尚未提交的命令。
- 通过当前终端会话传输，不限定连接方式；实际链路中的字符过滤、粘贴限制、tmux/relay 等仍需实机验证，不保证任意中间链路可用。
- 所有会话统一使用 `trz -B 10K`，用于引导时安装 `tsz` 及后续文件上传，降低 kube-exec 等中继截断大消息的风险。传输使用 Base64，不启用二进制模式。
- 首次引导逐块等待确认，接收端越大、链路延迟越高，耗时越长；纯 Shell 解码还受远端 CPU 和 Shell 实现影响。引导分块间隔默认 0 毫秒，收到确认后立即发送下一块；已保存的非零设置会保留，可在设置中改为 0，链路有粘贴限速时再增加。后续文件使用 trzsz；引导校验用于发现意外损坏，不替代来源可信性验证。
- 仅支持普通文件；不提供目录上传和断点续传。上传前建立本地临时副本，以免传输期间源文件变化。没有接收端缓存且下载源均不可用时，可以手动放入全平台压缩包，或先在远端安装兼容的 `trz`。
- 默认不覆盖，提交时使用硬链接拒绝已存在的普通文件。目标是目录或符号链接时始终拒绝。允许覆盖时在同一目录的临时区域完成传输后再重命名。
- 取消和失败会先停止客户端；传输阶段允许必要的失败帧让接收端退出，再中断远端工作 Shell。接收端退出确认和远端清理确认分别最多等待 1.5 秒；若客户端还有待启动或待结束的上传任务，会继续拦截输入和正常协议写入，直到任务结束后才释放会话。启动等待窗口中取消通常需要约 3 秒，以避免延迟的 `trz` 命令落入 Shell。断线、链路过滤或强制终止时远端清理只能尽力完成，可能残留 `.push-<随机标识>` 临时目录。

## 开发与验证

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

伪终端集成测试需要 Linux、Python 3 和 BusyBox。默认测试会使用 Node 版真实 `trz` 服务端，以及 `tabby-trzsz` npm 包中实际打包的客户端引擎，覆盖首次引导、接收端复用、空文件、二进制、特殊路径、碎片化输出、拒绝覆盖、失败不提交和取消恢复。解码器在 `/bin/sh` 与 BusyBox ash 下覆盖全部字节及非法输入。

额外验证本地原生接收端：

```sh
TRZ_BINARY=/absolute/path/to/trz pnpm test
```

验证固定发行包的缓存、解压及实际上传（Linux x86_64）：

```sh
TRZ_ALL_ARCHIVE=/path/to/trzsz-v1.3.0-all-platform.tar.gz pnpm test
```

已验证本地 PTY、BusyBox ash、全平台缓存复用、内置校验、备用源切换、预下载、手动缓存和取消下载，以及原生 Rust `trz` 引导和传输。尚未验证完整 Tabby GUI、真实 Alpine 容器、堡垒机或 tmux 链路。

原始需求和讨论记录保存在 [docs/design-notes.md](docs/design-notes.md)。
