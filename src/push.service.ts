import { Injectable } from '@angular/core'
import { ConfigService, HotkeysService, NotificationsService } from 'tabby-core'
import { BaseTerminalTabComponent, BaseTerminalProfile } from 'tabby-terminal'
import { promises as fs, constants } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomBytes } from 'crypto'
import { Subscription } from 'rxjs'
import { PushSettings, SavedFile, validateName, validateSettings } from './models'
import { remotePath, receiverLocation } from './shell'
import { PushOperation, TransferClient } from './operation'
import { PushMiddleware, PushInputLock } from './middleware'
import { ReceiverService } from './receiver.service'

export type PushTerminal = BaseTerminalTabComponent<BaseTerminalProfile> & {
    trzsz?: TransferClient
}

export function isSSHTerminal(tab: unknown): tab is PushTerminal {
    return (
        tab instanceof BaseTerminalTabComponent &&
        tab.profile?.type === 'ssh' &&
        !!tab.session?.open
    )
}

function localPath(value: string): string {
    const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
    if (!path.isAbsolute(expanded)) throw new Error('本地文件路径必须为绝对路径。')
    return expanded
}

@Injectable({ providedIn: 'root' })
export class PushService {
    private jobs = new Map<
        PushTerminal,
        { status: string; operation?: PushOperation; cancelled: boolean }
    >()

    constructor(
        private config: ConfigService,
        private notifications: NotificationsService,
        hotkeys: HotkeysService,
        private receivers: ReceiverService,
    ) {
        hotkeys.hotkey$.subscribe((key) => {
            if (key === 'ctrl-c') {
                for (const [tab] of this.jobs) if (tab.hasFocus) this.cancel(tab)
            }
        })
    }

    get settings(): PushSettings {
        return this.config.store.pushToolkit as PushSettings
    }
    status(tab: PushTerminal): string | undefined {
        return this.jobs.get(tab)?.status
    }
    cancel(tab: PushTerminal): void {
        const job = this.jobs.get(tab)
        if (job) {
            job.cancelled = true
            job.operation?.cancel()
        }
    }

    async push(tab: PushTerminal, file: SavedFile): Promise<void> {
        if (this.jobs.has(tab)) return
        const job: { status: string; operation?: PushOperation; cancelled: boolean } = {
            status: '检查本地文件…',
            cancelled: false,
        }
        this.jobs.set(tab, job)
        let temporary: string | undefined
        let middleware: PushMiddleware | undefined
        let inputLock: PushInputLock | undefined
        const subscriptions = new Subscription()
        const session = tab.session
        try {
            if (!isSSHTerminal(tab) || !session) throw new Error('请选择已连接的 SSH 终端。')
            if (tab.alternateScreenActive)
                throw new Error('请先退出全屏程序，回到远端 Shell 提示符。')
            if (!tab.trzsz)
                throw new Error(
                    'trzsz 尚未就绪。请重新打开 SSH 标签页，并检查 tabby-trzsz 是否已被禁用。',
                )
            if (tab.trzsz.isTransferringFiles()) throw new Error('当前终端已有传输正在进行。')
            const settings = JSON.parse(JSON.stringify(this.settings)) as PushSettings
            validateSettings(settings)
            const source = localPath(file.localPath)
            const name = validateName(file.remoteName || path.basename(source))
            receiverLocation(settings.receiverDirectory)
            remotePath(file.remoteDirectory)
            const stat = await fs.stat(source)
            if (!stat.isFile()) throw new Error('常用文件条目必须指向普通文件。')
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-push-'))
            const snapshot = path.join(temporary, name)
            await fs.copyFile(source, snapshot, constants.COPYFILE_EXCL)
            const fileSize = (await fs.stat(snapshot)).size
            if (!session.open || tab.session !== session)
                throw new Error('SSH 会话已改变，请重试。')
            if (job.cancelled) throw new Error('已取消上传。')
            const operation = new PushOperation(
                {
                    token: randomBytes(16).toString('hex'),
                    receiverDirectory: settings.receiverDirectory,
                    destination: file.remoteDirectory,
                    filename: name,
                    fileSize,
                    executable: !!file.executable,
                    overwrite: !!file.overwrite,
                    localPath: snapshot,
                    settings,
                    loadReceiver: (platform, architecture, signal) =>
                        this.receivers.load(
                            platform,
                            architecture,
                            signal,
                            (status) => {
                                job.status = status
                                void tab.write(`\r\n[Push Toolkit] ${status}\r\n`)
                            },
                            settings,
                        ),
                    status: (status) => {
                        job.status = status
                        void tab.write(`\r\n[Push Toolkit] ${status}\r\n`)
                    },
                },
                tab.trzsz,
                (data) => {
                    if (session.open) session.write(data)
                },
            )
            job.operation = operation
            middleware = new PushMiddleware(operation)
            inputLock = new PushInputLock(() => operation.cancel())
            session.middleware.unshift(middleware)
            session.middleware.push(inputLock)
            subscriptions.add(session.closed$.subscribe(() => operation.cancel('SSH 连接已断开。')))
            subscriptions.add(
                tab.sessionChanged$.subscribe((current) => {
                    if (current !== session) operation.cancel('SSH 会话已改变。')
                }),
            )
            await operation.run()
            this.notifications.info('Push Toolkit：上传完成', `${file.remoteDirectory}/${name}`)
        } catch (error) {
            this.notifications.error(
                'Push Toolkit：上传失败',
                error instanceof Error ? error.message : String(error),
            )
        } finally {
            subscriptions.unsubscribe()
            if (middleware && session?.open) session.middleware.remove(middleware)
            if (inputLock && session?.open) session.middleware.remove(inputLock)
            middleware?.close()
            inputLock?.close()
            this.jobs.delete(tab)
            if (temporary)
                await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        }
    }
}
