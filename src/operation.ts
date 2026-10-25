import { adler32, posixCksum } from './shell'
import { FrameParser } from './frames'
import { DEFAULT_RECEIVER_DIRECTORY, PushSettings } from './models'
import { WorkerOptions, workerCommand } from './worker'
import { ReceiverBinaries } from './receiver-cache'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Public methods exposed as terminal.trzsz by tabby-trzsz 1.0.7. */
export interface TransferClient {
    uploadFiles(paths: string[]): Promise<unknown>
    stopTransferringFiles(): void
    isTransferringFiles(): boolean
}

export interface OperationOptions extends WorkerOptions {
    localPath?: string
    settings: PushSettings
    loadReceiver: (
        platform: string,
        architecture: string,
        signal: AbortSignal,
    ) => Promise<ReceiverBinaries>
    status: (message: string) => void
    onStopped?: () => void
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function remoteError(code: string): Error {
    const reasons: Record<string, string> = {
        ENDIANNESS:
            '无法确定 MIPS 端序；请确保 od 可用且能读取 Shell 的 ELF 文件，或先安装兼容的 trz。',
        EXISTS: '目标文件已存在；请修改文件名或在条目中启用覆盖。',
        TARGET_TYPE: '目标是目录或符号链接；请选择普通文件路径。',
        RECEIVER_EXEC: '接收端无法执行；请检查远端架构、musl/glibc 兼容性和 noexec 挂载。',
        SENDER_EXEC: 'tsz 无法执行；请检查远端架构和执行权限。',
        SENDER_MISSING: 'tsz 上传不完整，未安装发送端。',
        SENDER_COMMIT: '无法安装 tsz；请检查远端工具目录和写入权限。',
        CHMOD: '无法赋予执行权限；请检查文件系统和远端权限。',
        DECODE: '引导数据被截断、损坏或无法写入；请检查链路过滤和磁盘空间。',
        CHECKSUM: '引导文件大小或校验和不一致，未安装接收端。',
        SIZE: '落盘文件大小不一致，未提交文件；请检查磁盘空间。',
        RECEIVER_DIRECTORY: '无法创建接收端目录；请检查接收端路径和写入权限。',
        DESTINATION: '无法创建目标目录；请检查路径和写入权限。',
        TRANSFER: 'trz 接收端退出失败；请检查接收端兼容性和当前会话。',
        FILE_COMMIT: '无法提交文件；请检查目标是否已存在、写入权限及硬链接支持。',
    }
    const reason = code.startsWith('MISSING_')
        ? `远端缺少 ${code.slice(8)}；请使用提供所需基本命令的环境。`
        : (reasons[code] ?? '远端操作未完成，请检查当前 Shell、路径和权限。')
    return new Error(`远端操作失败 [${code}]：${reason}`)
}

export class PushOperation {
    private phase: 'bootstrap' | 'kickoff' | 'transfer' | 'closed' = 'bootstrap'
    private parser: FrameParser
    private frames: string[] = []
    private error?: Error
    private waiting?: {
        prefix: string
        resolve: (value: string) => void
        reject: (error: Error) => void
    }
    private timer?: ReturnType<typeof setTimeout>
    private handshake = Buffer.alloc(0)
    private handshakeSeen = false
    private stopSeen = false
    private stopped?: () => void
    private remoteStopping = false
    private upload?: Promise<unknown>
    private receiverReturned = false
    private receiverExited?: () => void
    private abortController = new AbortController()

    constructor(
        private options: OperationOptions,
        private client: TransferClient,
        private write: (data: Buffer) => void,
    ) {
        this.parser = new FrameParser(options.token, (message) => this.onFrame(message))
    }

    /** Called before tabby-trzsz sees output. Bootstrap traffic stays private. */
    feedFromSession(data: Buffer): Buffer {
        this.touch()
        try {
            // Filter each span in wire order: STOPPED and the shell prompt may share a packet.
            return this.parser.feed(data, (output) => this.filterOutput(output))
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)))
        }
        return Buffer.alloc(0)
    }

    private filterOutput(output: Buffer): Buffer {
        // Cleanup has restored the TTY. Keep forwarding even while local cleanup is pending.
        if (this.stopSeen) return output
        if (this.phase !== 'transfer' || (this.error && this.receiverReturned))
            return Buffer.alloc(0)
        if (this.handshakeSeen) return output
        // Upstream detects a handshake within a single output buffer. SSH can split it.
        this.handshake = Buffer.concat([this.handshake, output])
        if (
            /::TRZSZ:TRANSFER:[RD]:\d+\.\d+\.\d+:\d+(?::\d+)*[\r\n]/.test(this.handshake.toString())
        ) {
            this.handshakeSeen = true
            const result = this.handshake
            this.handshake = Buffer.alloc(0)
            return result
        }
        if (this.handshake.length > 65536) this.fail(new Error('接收端未返回有效的 trzsz 握手。'))
        return Buffer.alloc(0)
    }

    /** Called on the wire side of upstream's middleware, including its generated input. */
    feedFromTerminal(data: Buffer): void {
        if (this.phase === 'closed') return
        if (this.error) {
            if (this.phase === 'transfer' && !this.receiverReturned) {
                // A handshake may have been queued before cancellation. Stop it as soon as
                // upstream activates, but allow only its abort frame to reach the raw receiver.
                this.client.stopTransferringFiles()
                if (/^#(?:fail|FAIL):[A-Za-z0-9+/=]*\r?\n$/.test(data.toString())) this.write(data)
            }
            return
        }
        if (this.phase === 'kickoff') {
            // uploadFiles first sends Ctrl+C, then a literal trz command. Keep our worker alive
            // and start its configured receiver instead of resolving trz through the shell PATH.
            if (data.toString() === 'trz\r') {
                this.phase = 'transfer'
                this.send('GO\n')
            }
            return
        }
        if (this.phase === 'transfer') {
            this.touch()
            this.write(data)
        } else if (data.includes(3)) {
            this.cancel()
        }
    }

    cancel(reason = '已取消当前操作。'): void {
        this.fail(new Error(reason))
    }

    private fail(error: Error): void {
        if (this.error || this.phase === 'closed') return
        this.error = error
        this.abortController.abort(error)
        this.client.stopTransferringFiles()
        this.waiting?.reject(error)
        this.waiting = undefined
        clearTimeout(this.timer)
    }

    private onFrame(message: string): void {
        if (
            ['RECEIVED', 'SENDER_RECEIVED', 'STOPPED'].includes(message) ||
            message.startsWith('ERROR:')
        ) {
            this.receiverReturned = true
            this.receiverExited?.()
        }
        if (message === 'STOPPED' && !this.stopSeen) {
            this.options.onStopped?.()
            this.stopSeen = true
            this.stopped?.()
        }
        if (message.startsWith('ERROR:')) {
            this.remoteStopping = true
            this.fail(remoteError(message.slice(6)))
            return
        }
        // Write completion before allowing the following shell prompt through, even if both
        // arrive in one buffer (promise continuations run only after feedFromSession returns).
        if (!this.error) {
            if (message === 'BOOTSTRAP_DONE') this.options.status('trz 和 tsz 已就绪。')
            if (message === 'DONE') this.options.status('上传完成。')
        }
        if (this.waiting && message.startsWith(this.waiting.prefix)) {
            const waiter = this.waiting
            this.waiting = undefined
            clearTimeout(this.timer)
            waiter.resolve(message)
        } else {
            this.frames.push(message)
        }
    }

    private touch(): void {
        if (!this.waiting) return
        clearTimeout(this.timer)
        this.timer = setTimeout(
            () => this.fail(new Error('远端响应超时，请检查会话、Shell 提示符和链路过滤。')),
            this.options.settings.timeoutMs,
        )
    }

    private wait(prefix: string): Promise<string> {
        if (this.error) return Promise.reject(this.error)
        const index = this.frames.findIndex((frame) => frame.startsWith(prefix))
        if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0])
        return new Promise((resolve, reject) => {
            this.waiting = { prefix, resolve, reject }
            this.touch()
        })
    }

    private send(text: string): void {
        if (this.error) throw this.error
        this.write(Buffer.from(text))
    }

    private async finish(frame: 'DONE' | 'BOOTSTRAP_DONE'): Promise<void> {
        await this.wait(frame)
        await this.wait('STOPPED')
    }

    private async transfer(localPath: string, received: string): Promise<void> {
        this.phase = 'kickoff'
        this.receiverReturned = false
        this.handshakeSeen = false
        this.handshake = Buffer.alloc(0)
        const upload = this.client.uploadFiles([localPath])
        this.upload = upload
        void upload.catch((error) =>
            this.fail(error instanceof Error ? error : new Error(String(error))),
        )
        await this.wait(received)
        await upload
        if (this.error) throw this.error
        this.phase = 'bootstrap'
        this.send('COMMIT\n')
    }

    private async stageSender(data: Buffer): Promise<{ directory: string; path: string }> {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-push-tsz-'))
        const sender = path.join(directory, 'tsz')
        await fs.writeFile(sender, data)
        return { directory, path: sender }
    }

    async run(): Promise<void> {
        if (this.client.isTransferringFiles()) throw new Error('当前终端已有 trzsz 传输正在进行。')
        let senderDirectory: string | undefined
        try {
            this.options.status(this.options.bootstrapOnly ? '检测远端传输端…' : '检测远端接收端…')
            const [launcher, ...script] = workerCommand(this.options).trimEnd().split('\n')
            this.send(`${launcher}\n`)
            // Wait until the interactive shell has handed the TTY to our child reader.
            // In particular, Zsh's line editor can otherwise consume or transform early input.
            await this.wait('SCRIPT_READY')
            // Pace shell program lines as well as data; never paste a large command at once.
            for (const line of script) {
                this.send(`${line}\n`)
                await delay(Math.max(2, this.options.settings.chunkDelayMs))
            }
            const probe = (await this.wait('PROBE:')).split(':')
            if (this.options.bootstrapOnly && probe[3] === '1') {
                if (probe[4] === '1') {
                    this.send('USE\n')
                    await this.finish('BOOTSTRAP_DONE')
                    return
                }

                const tools = await this.options.loadReceiver(
                    probe[1],
                    probe[2],
                    this.abortController.signal,
                )
                if (!tools.tsz.length) throw new Error('tsz 文件为空。')
                const staged = await this.stageSender(tools.tsz)
                senderDirectory = staged.directory
                this.options.status(
                    `通过 trzsz 安装 tsz 到 ${this.options.receiverDirectory || DEFAULT_RECEIVER_DIRECTORY}…`,
                )
                this.send(`USE:${tools.tsz.length}\n`)
                await this.transfer(staged.path, 'SENDER_RECEIVED')
                await this.wait('SENDER_DONE')
                await this.finish('BOOTSTRAP_DONE')
                return
            }

            if (probe[3] === '1') {
                this.options.status(
                    this.options.bootstrapOnly
                        ? '未找到远端 trz，开始引导 trz 和 tsz…'
                        : '使用远端已安装的 trz…',
                )
                this.send('USE\n')
            } else {
                const tools = await this.options.loadReceiver(
                    probe[1],
                    probe[2],
                    this.abortController.signal,
                )
                const data = tools.trz
                if (!data.length || !tools.tsz.length) throw new Error('trz 或 tsz 文件为空。')
                const staged = await this.stageSender(tools.tsz)
                senderDirectory = staged.directory
                const [a, b] = adler32(data)
                this.send(`BOOT:${data.length}:${a}:${b}:${posixCksum(data)}:${tools.tsz.length}\n`)
                const native = (await this.wait('BOOT:')) === 'BOOT:NATIVE'
                this.options.status(native ? '使用原生 Base64 快速引导…' : '使用纯 Shell 兼容引导…')
                let sequence = 0
                let progress = -1
                let sumA = 1,
                    sumB = 0
                for (let offset = 0; offset < data.length; offset += 768) {
                    const chunk = data.subarray(offset, offset + 768)
                    if (!native) {
                        for (const byte of chunk) {
                            sumA = (sumA + byte) % 65521
                            sumB = (sumB + sumA) % 65521
                        }
                    }
                    this.send(`${chunk.toString('base64')}\n`)
                    const frame = await this.wait('ACK:')
                    const sent = offset + chunk.length
                    const checksum = native ? `${posixCksum(chunk)}` : `${sumA}:${sumB}`
                    if (frame !== `ACK:${++sequence}:${sent}:${checksum}`)
                        throw new Error('引导分块校验失败，已停止上传。')
                    const percent = Math.floor((sent * 100) / data.length / 10) * 10
                    if (percent !== progress) {
                        progress = percent
                        this.options.status(`引导接收端 ${percent}% (${sent}/${data.length} 字节)`)
                    }
                    if (this.options.settings.chunkDelayMs > 0)
                        await delay(this.options.settings.chunkDelayMs)
                }
                this.send('END\n')
                await this.wait('SENDER_READY')
                this.options.status(
                    `通过 trzsz 安装 tsz 到 ${this.options.receiverDirectory || DEFAULT_RECEIVER_DIRECTORY}…`,
                )
                await this.transfer(staged.path, 'SENDER_RECEIVED')
                await this.wait('SENDER_DONE')
            }
            if (this.options.bootstrapOnly) {
                await this.finish('BOOTSTRAP_DONE')
                return
            }
            await this.wait('READY')
            this.options.status('通过 trzsz 上传文件…')
            if (!this.options.localPath) throw new Error('缺少待上传的本地文件。')
            await this.transfer(this.options.localPath, 'RECEIVED')
            await this.finish('DONE')
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error))
            this.fail(failure)
            throw failure
        } finally {
            clearTimeout(this.timer)
            if (this.error && this.phase === 'transfer') {
                // Let upstream send its abort before interrupting a receiver in raw mode.
                await this.upload?.catch(() => undefined)
                if (!this.receiverReturned)
                    await Promise.race([
                        new Promise<void>((resolve) => {
                            this.receiverExited = resolve
                        }),
                        delay(1500),
                    ])
                this.receiverExited = undefined
                this.phase = 'bootstrap'
            }
            if (this.error && !this.stopSeen) {
                // An interrupt terminates the child worker and runs its cleanup traps.
                // In a filtered/broken connection cleanup is necessarily best effort.
                if (!this.remoteStopping) this.write(Buffer.from('\x03'))
                await Promise.race([
                    new Promise<void>((resolve) => {
                        this.stopped = resolve
                    }),
                    delay(1500),
                ])
            }
            // stopTransferringFiles() cannot cancel upstream's pending startup delay.
            // Keep the wire/input guards installed until that upload has fully settled,
            // otherwise its delayed trz command can escape into the user's shell.
            await this.upload?.catch(() => undefined)
            this.phase = 'closed'
            if (senderDirectory)
                await fs
                    .rm(senderDirectory, { recursive: true, force: true })
                    .catch(() => undefined)
        }
    }
}
