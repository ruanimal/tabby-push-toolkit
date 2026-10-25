# tabby-push-toolkit

通过当前 Tabby SSH 终端把常用本地文件推送到精简远程环境。优先使用远端已安装的 `trz`；没有可用接收端时，才以纯 POSIX Shell Base64 解码引导接收端。连接沿用当前终端，包括 SSH 跳板链路，不另建 SCP/SFTP 连接。

## 功能

- 设置中保存多个常用文件：名称、本地路径、远端目录、目标文件名、执行权限、覆盖策略。
- SSH 标签页或终端右键 → **Push Toolkit** → 选择常用文件。
- 自动查找指定命令或路径、远端 `PATH` 中的 `trz` 和工具包已引导的接收端。已有接收端时无需配置本地文件、平台或架构，也不要求其实现 `--version`；兼容性由实际传输握手确认。
- 仅在需要引导时，根据远端 `uname -s` / `uname -m` 选择本地接收端；不使用本机架构推断远端架构。
- 引导每块最多 768 字节，逐块确认序号、累计字节数和 Adler-32，落盘大小一致并能启动后再替换接收端。
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
2. **远端 trz 命令或路径**默认填写 `trz`，也可留空自动检测，或指定 `/usr/local/bin/trz`、`~/bin/trz` 等已安装路径。此处填写单个命令名或路径，不接受附加 Shell 参数。远端已经安装 `trz` 时，直接跳过“引导接收端”配置即可。
3. 仅在远端没有可用 `trz` 时，在本机准备与远端系统和架构匹配的 **`trz` 接收端可执行文件**，并在 **引导接收端（可选）**中配置平台、架构和本地文件，例如 `Linux`、`x86_64`、`/home/me/tools/trz`。先在本机解压发行包，不要选择 `.tar.gz`、`.zip` 或 `trzsz` 包装程序。Alpine 优先选 musl 静态版本。`amd64` 与 `x86_64`、`arm64` 与 `aarch64` 可互相匹配。相同平台和架构只允许一个有效引导文件；尚未选择本地文件的空白条目不影响保存或使用已安装接收端。
4. 保存设置。回到已连接的 SSH 终端，确保当前处于空闲 Shell 提示符，右键选择条目。

每次依次检测指定命令或路径、`PATH` 中的 `trz`、工具包的引导路径。对于命令名或自动检测，缺少接收端时引导安装到 `~/.local/lib/tabby-push-toolkit/trz`；填写 `/` 或 `~/` 开头的路径时，引导安装到该路径。目录不存在时自动创建。已有配置路径继续有效，每次都会重新检测，不依赖会话缓存。

需求记录提及的候选版本为 [trzsz-rs v1.3.0](https://github.com/ruanimal/trzsz-rs/releases/tag/v1.3.0)。本次未能从公开发布接口取得该版本，未宣称它的附件或兼容性已经验证；可手动选择任何经过验证、协议兼容的 `trz` 接收端。

## 远端要求与限制

远端需要 POSIX `sh`、`mkdir`、`rm`、`mv`、`ln`、`wc`；首次引导额外需要 `chmod` 和 `uname`，赋予上传文件执行权限时需要 `chmod`。使用已安装接收端不要求检测平台和架构。BusyBox 可提供这些工具。`stty` 可用时会保存终端状态、关闭回显并在退出时恢复。**不需要** `rz/sz`、`scp`、`sftp`、`base64`、`tar/gzip` 或包管理器。

- 远端目录必须可写且允许执行上传的程序；`noexec` 或执行策略禁止时无法引导。
- 必须在空闲、支持 POSIX 命令引用的 Shell 提示符下操作。全屏程序会被拒绝，但无法可靠检测所有前台程序或尚未提交的命令。
- 通过当前会话传输，因此可沿用已有 SSH 跳板连接；实际堡垒机的字符过滤、粘贴限制、tmux/relay 仍需实机验证，不保证任意中间链路可用。
- 首次引导逐块等待确认，接收端越大、链路延迟越高，耗时越长。后续文件使用 trzsz；引导用的 Adler-32 用于发现意外损坏，不替代来源可信性验证。
- 仅支持普通文件；不提供目录上传、在线下载接收端、断点续传和安装包自动解析。上传前建立本地临时副本，以免传输期间源文件变化。
- 默认不覆盖，提交时使用硬链接拒绝已存在的普通文件。目标是目录或符号链接时始终拒绝。允许覆盖时在同一目录的临时区域完成传输后再重命名。
- 取消和失败会中断远端工作 Shell，并等待清理确认后释放输入，最多等待 1.5 秒。断线、链路过滤或强制终止时清理只能尽力完成，可能残留 `.push-<随机标识>` 临时目录。

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

已验证本地 PTY、BusyBox ash 与原生 Rust `trz 1.2.0`。约 814 KiB 接收端的本地引导及随后约 250 KiB 文件上传用时约 17 秒（分块间隔为 0，不代表 SSH 链路耗时）。尚未验证完整 Tabby GUI、真实 Alpine 容器、SSH 堡垒机或 tmux 链路。

原始需求和讨论记录保存在 [docs/design-notes.md](docs/design-notes.md)。
