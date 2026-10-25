# tabby-push-toolkit

[简体中文](README.md) | English

Push frequently used local files to the target environment through the currently connected Tabby terminal session. No specific connection type is required: local and remote sessions can both be used when they meet the environment requirements below. Transfers reuse the current terminal without opening a separate file-transfer connection. The plugin prefers an existing `trz` in the target environment; only when no usable receiver is available does it bootstrap one over Base64, preferring available native decoding tools and falling back to pure POSIX shell.

Throughout this document, “remote” refers to the target environment in the current terminal session, which may also be the local machine.

## Features

- Save multiple frequently used files in settings, including a name, local path, remote directory, target filename, executable permission, and overwrite policy.
- Right-click a connected terminal → **Push Toolkit** → choose **引导传输端** (Bootstrap transfer tools) to install `trz` and `tsz`, or choose a saved file to upload it directly. Start operations at an idle shell prompt in the target environment.
- Look for `trz` in the configured remote tools directory first, then in the remote `PATH`. An existing receiver needs no local file, platform, or architecture configuration and does not have to implement `--version`; compatibility is confirmed by the actual transfer handshake.
- When bootstrapping is needed, download the all-platform archive from the pinned [trzsz-rs v1.3.0 release](https://github.com/ruanimal/trzsz-rs/releases/tag/v1.3.0) and select the inner release archive for the remote platform. Linux uses static musl builds, preferring the release's UPX variants to reduce the initial transfer size.
- Checksum manifests are embedded in the plugin, and archives are cached in the current Tabby configuration directory. Supports GitHub, Gitee, and custom download sources, pre-downloading, opening the cache directory, and manually supplied archives. After verifying the embedded SHA-256 checksums, the plugin extracts `trz` and `tsz` locally without requiring manual platform or architecture selection.
- Install both `trz` and `tsz` into the configured remote tools directory (default: `~/.local/bin`) and add it to the current terminal session's `PATH`. Bootstrap `trz` over Base64, then upload `tsz` through the protocol; install both only after successful verification.
- Bootstrap in chunks of at most 768 bytes, acknowledging each chunk's sequence number, cumulative byte count, and checksum. When remote `base64`, `cksum`, and `cat` are available and pass a self-test, use native decoding with POSIX `cksum` checks for each chunk and the complete file; otherwise use pure shell decoding with cumulative Adler-32. Replace the receiver only after confirming the on-disk size and that it can start.
- Upload with trzsz into a temporary directory and commit the file only after the client protocol succeeds and the remote size matches. Overwriting is disabled by default; when enabled, replacement uses an atomic rename on the same filesystem.
- Show the current stage and bootstrap progress. View status or cancel from the context menu, or cancel with Ctrl+C. Terminal input is intercepted during transfers to prevent keyboard input from mixing with the file stream.

## Installation and dependencies

The runtime dependencies include the pinned **`tabby-trzsz@1.0.7`** package; users do not need to install it separately. Push Toolkit explicitly imports its Angular module so its settings and terminal decorators work even when npm installs the dependency in a nested directory. Angular deduplicates the module if Tabby also discovers it during plugin scanning.

Uploads reuse the `trzsz.uploadFiles()` API exposed by `tabby-trzsz` on the current terminal. During each operation, the toolkit coordinates its startup command and session stream rather than installing a second protocol engine. This integration targets version 1.0.7 and has contract and transfer tests against the actual published npm package.

The project is currently available as source and has not been published to npm. To load it for development:

```sh
pnpm install
pnpm build
TABBY_PLUGINS=/absolute/path/to/tabby-push-toolkit tabby
```

Fully quit any existing Tabby processes before restarting. `TABBY_PLUGINS` points to the project directory, using the same plugin structure as `tabby-tmux`. Run `pnpm pack` to create `tabby-push-toolkit-0.1.0.tgz`, then install it with npm in Tabby's user plugin directory and restart Tabby. For example:

```sh
npm --prefix /path/to/tabby/plugins install /absolute/path/to/tabby-push-toolkit-0.1.0.tgz --omit=dev --legacy-peer-deps
```

Tabby Desktop provides Angular 15, RxJS 7, `tabby-core`, `tabby-electron`, `tabby-settings`, and `tabby-terminal`.

## Initial setup

The UI labels below retain their Chinese text so you can match them in the settings and context menu.

1. Open **Settings → Push Toolkit**, add a saved file, and enter its absolute local path and a remote directory such as `~/tools`. Remote directories must start with `/` or `~/`; other shell variables are not expanded. Leave the target filename blank to use the local filename.
2. **远端工具目录** (Remote tools directory) defaults to `~/.local/bin`; leaving it blank uses the same default. You can change it to a directory such as `/usr/local/bin` or `~/tools/bin`, but it must start with `/` or `~/`. This setting controls where the plugin looks for and installs `trz` and `tsz`.
3. Select a receiver download source: GitHub is the default, Gitee is the fallback, and custom sources are supported. Click **预下载接收端** (Pre-download receiver) to populate the cache in advance. This requires no open terminal session and does not save other unfinished settings.
4. Save the settings. Return to a connected terminal session at an idle shell prompt in the target environment, then right-click and select **Push Toolkit → 引导传输端** (Bootstrap transfer tools), or select a saved file directly. If the remote system lacks `trz` or `tsz`, the plugin automatically identifies its platform and downloads, caches, and bootstraps `trzsz-rs v1.3.0`.

Each operation checks for `trz` in the configured directory first, then in `PATH`. If neither is usable, it bootstraps `trz` and `tsz` into the configured directory, creating it if needed. For example, setting the tools directory to `~/tools/bin` checks `~/tools/bin/trz` first and installs both programs into `~/tools/bin` when bootstrapping is needed. Detection runs every time and does not rely on a session cache.

After bootstrapping, you can run `trz` to upload or `tsz /path/to/file` to download in the current session; Tabby's trzsz support handles the protocol. To use these commands directly in future login sessions, ensure your login shell's `PATH` includes the configured remote tools directory (default: `~/.local/bin`).

## Receiver cache

The cache lives at `push-toolkit/receivers/v1.3.0/` under the directory containing the **current `config.yaml`**. The settings page shows the actual path, including custom and portable Tabby configuration locations. For example, with the default Linux configuration directory:

```text
~/.config/tabby/push-toolkit/receivers/v1.3.0/
├── trzsz-v1.3.0-all-platform.tar.gz
├── trzsz-v1.3.0-x86_64-unknown-linux-musl-upx.tar.gz
├── trzsz-v1.3.0-aarch64-unknown-linux-musl-upx.tar.gz
└── …other platform archives
```

Click **打开缓存目录** (Open cache directory) in settings to create and open this directory. **预下载接收端** (Pre-download receiver) downloads and caches the all-platform archive (about 36 MB), then verifies its 28 platform archives individually and writes them to the same cache directory. No open terminal session is needed. The operation can be cancelled and reuses an existing complete, valid cache. You can also download the archive from one of the URLs below and place it in the cache directory as `trzsz-v1.3.0-all-platform.tar.gz`; pre-downloading or the first bootstrap will detect and extract it automatically. Individual platform archives from the release can also be placed there directly; they are verified and used during bootstrapping.

Built-in download sources:

- [GitHub (default)](https://github.com/ruanimal/trzsz-rs/releases/download/v1.3.0/trzsz-v1.3.0-all-platform.tar.gz)
- [Gitee (fallback)](https://gitee.com/iponder/trzsz-rs/releases/download/v1.3.0/trzsz-v1.3.0-all-platform.tar.gz)

In settings, select a preferred download source or add a custom name and full HTTP/HTTPS archive URL. The selected source is tried first; network, HTTP, or checksum failures trigger attempts with the remaining built-in sources. Cancellation does not trigger fallback downloads. Custom sources must serve exactly the same v1.3.0 all-platform archive as the built-in sources.

SHA-256 checksums for the all-platform archive and its 28 inner release archives are embedded in the plugin. The plugin neither downloads a checksum manifest nor trusts manifests from mirrors or the cache directory. The all-platform archives from both built-in sources have been confirmed to contain identical content. The all-platform archive is verified first; after extraction, every platform archive is checked against the embedded manifest and cached separately. Bootstrapping prefers the cached platform archive and extracts only that archive to obtain `trz` and `tsz`, without rereading or extracting the all-platform archive. A complete platform cache remains usable even if the all-platform archive is removed. Missing or corrupt platform archives can be extracted again from the cached all-platform archive without another download. Manually supplied archives undergo the same checks and are downloaded again if corrupt. Different remote platforms and pre-download operations can share a single download, and verified caches remain available offline after restarting Tabby. Downloads use Electron's networking API, inherit Tabby's system proxy configuration, and support cancellation and timeouts.

Archives stay in the local configuration directory. The extracted `trz` is read into memory, while `tsz` is stored in a local temporary file for protocol upload and removed when the operation ends. Downloaded programs are never executed locally. The remote system still needs no `tar`, `gzip`, or download tools. Automatic bootstrapping supports the Linux musl architectures and macOS x86_64/aarch64 builds provided by the pinned release. Unsupported platforms are prompted to install a compatible `trz` first.

## Remote requirements and limitations

The remote system needs POSIX `sh`, `mkdir`, `rm`, `mv`, `ln`, and `wc`. Initial bootstrapping additionally requires `chmod` and `uname`; granting executable permission to an uploaded file also requires `chmod`. Bootstrapping on 32-bit MIPS additionally needs `od` to read the shell executable's ELF endianness. The plugin first reads `/proc/<Shell PID>/exe`, then tries the shell's path in `PATH` and `/bin/sh` if necessary. It fails explicitly if endianness cannot be determined rather than guessing. Using an existing receiver requires no platform or architecture detection. BusyBox can provide these tools. If `stty` is available, the terminal state is saved, echo is disabled, and the state is restored on exit. **No** `rz/sz`, `scp`, `sftp`, `base64`, `tar/gzip`, or package manager is required.

- The remote directory must be writable and allow execution of uploaded programs. Bootstrapping cannot work on `noexec` mounts or when execution policies block it.
- Start operations at an idle shell prompt that supports POSIX command quoting. Full-screen applications are rejected, but not every foreground process or unsubmitted command can be detected reliably.
- Transfers use the current terminal session without requiring a specific connection type. Character filtering, paste limits, and tmux/relay behavior along the actual connection path still need testing on the target setup; arbitrary intermediary chains are not guaranteed to work.
- All sessions use `trz -B 10K` when installing `tsz` and uploading files to reduce the risk of large messages being truncated by kube-exec and other relays. Transfers use Base64 without binary mode.
- Initial bootstrapping waits for an acknowledgment after each chunk. Larger receivers and higher-latency connections take longer; pure shell decoding also depends on the remote CPU and shell implementation. The default chunk delay is 0 ms, sending the next chunk immediately after acknowledgment. Existing nonzero settings are preserved; set the delay to 0 in settings, increasing it if the connection limits pasted input. Subsequent file transfers use trzsz. Bootstrap checksums detect accidental corruption; they are not a substitute for verifying source authenticity.
- Only regular files are supported; directory uploads and resumable transfers are not provided. A local temporary copy is created before upload so changes to the source file do not affect the transfer. If no receiver is cached and all download sources are unavailable, manually supply the all-platform archive or install a compatible `trz` on the remote system first.
- Overwriting is disabled by default. Committing uses a hard link to reject existing regular files. Targets that are directories or symbolic links are always rejected. When overwriting is allowed, the transfer completes in a temporary area in the same directory before the file is renamed into place.
- Cancellation and failures stop the client first. During transfers, necessary failure frames are allowed through so the receiver can exit before the remote worker shell is interrupted. Receiver-exit confirmation and remote-cleanup confirmation each wait up to 1.5 seconds. If a client upload task is still waiting to start or finish, input and normal protocol writes remain intercepted until the task ends, and only then is the session released. Cancelling during the startup wait usually takes about 3 seconds to prevent a delayed `trz` command from reaching the shell. Remote cleanup is best-effort after disconnection, link filtering, or forced termination, so `.push-<random identifier>` temporary directories may remain.

## Development and verification

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Pseudo-terminal integration tests require Linux, Python 3, and BusyBox. By default, tests use a real Node.js `trz` server and the client engine actually bundled in the published `tabby-trzsz` npm package. They cover initial bootstrapping, receiver reuse, empty files, binary data, special paths, fragmented output, overwrite rejection, failure without committing, and cancellation recovery. Decoder tests cover every byte value and invalid input under both `/bin/sh` and BusyBox ash.

To additionally test a local native receiver:

```sh
TRZ_BINARY=/absolute/path/to/trz pnpm test
```

To test caching, extraction, and actual uploads with the pinned release archive (Linux x86_64):

```sh
TRZ_ALL_ARCHIVE=/path/to/trzsz-v1.3.0-all-platform.tar.gz pnpm test
```

The project's existing verification covers local PTYs, BusyBox ash, all-platform cache reuse, embedded checksums, fallback sources, pre-downloading, manually supplied caches, download cancellation, and native Rust `trz` bootstrapping and transfers. The full Tabby GUI, real Alpine containers, bastion hosts, and tmux connections have not yet been verified.

Original requirements and discussion notes are available in [docs/design-notes.md](docs/design-notes.md) (Chinese).
