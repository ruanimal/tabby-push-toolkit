import { Component, OnDestroy } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import { ElectronHostWindow, ElectronService } from 'tabby-electron'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { defaults, PushSettings, validateName, validateSettings } from './models'
import { remoteUploadDirectory, receiverLocation } from './shell'
import { RECEIVER_VERSION, RECEIVER_RELEASE_URL, receiverCacheDirectory } from './receiver-cache'
import { RECEIVER_ARCHIVE, RECEIVER_SOURCES } from './receiver-release'
import { ReceiverService } from './receiver.service'

@Component({
    host: { '(input)': 'saved = false', '(change)': 'saved = false' },
    template: `
        <h3>Push Toolkit</h3>
        <p class="text-muted">
            通过当前终端会话推送常用文件。请在目标环境的 Shell
            空闲提示符下操作；上传期间输入会被接管，Ctrl+C 可取消。
        </p>
        <p class="text-muted">
            需要安装并启用 tabby-trzsz 1.0.7 或兼容的 1.x 版本。优先使用远端已安装的
            trz；需要引导时自动下载固定版本，无需手动选择平台或本地文件。
        </p>

        <h4>常用文件</h4>
        <section *ngFor="let file of draft.files; let i = index">
            <label
                >显示名称<input class="form-control" [(ngModel)]="file.name" aria-label="显示名称"
            /></label>
            <label
                >本地文件
                <div class="path-row">
                    <input
                        class="form-control"
                        [(ngModel)]="file.localPath"
                        aria-label="本地文件"
                    /><button class="btn btn-secondary" (click)="pickFile(file)">浏览…</button>
                </div></label
            >
            <label
                >远端目录<input
                    class="form-control"
                    [(ngModel)]="file.remoteDirectory"
                    placeholder=". 或 ~/tools"
                    aria-label="远端目录"
            /></label>
            <p class="text-muted">
                填 . 或 ./ 使用上传时当前 Shell 的工作目录，也支持以 / 或 ~/ 开头的目录。
            </p>
            <label
                >目标文件名（留空使用本地文件名）<input
                    class="form-control"
                    [(ngModel)]="file.remoteName"
                    aria-label="目标文件名"
            /></label>
            <div class="options">
                <label><input type="checkbox" [(ngModel)]="file.executable" /> 赋予执行权限</label
                ><label
                    ><input type="checkbox" [(ngModel)]="file.overwrite" /> 允许覆盖同名文件</label
                >
            </div>
            <button class="btn btn-danger btn-sm" (click)="draft.files.splice(i, 1)">
                删除条目
            </button>
        </section>
        <button class="btn btn-secondary" (click)="addFile()">添加常用文件</button>

        <h4>接收端</h4>
        <p class="text-muted">
            固定使用
            <a [href]="receiverReleaseURL" (click)="openRelease($event)"
                >trzsz-rs {{ receiverVersion }}</a
            >。下载全平台压缩包并按内置清单校验，需要引导时自动提取对应平台的 trz 和 tsz，
            一起安装到下方指定的目录。Linux 使用静态 musl 版本。
        </p>
        <p>
            压缩包缓存目录：<code>{{ receiverCachePath }}</code>
            <button class="btn btn-secondary btn-sm" (click)="openCacheDirectory()">
                打开缓存目录
            </button>
        </p>
        <p class="text-muted">
            预下载会展开总包，将各平台压缩包分别缓存。可自行将 {{ receiverArchive }}
            或对应平台压缩包放入此目录，使用前会按内置 SHA-256 校验。
        </p>
        <label
            >接收端下载源
            <select
                class="form-control"
                [(ngModel)]="draft.receiverDownloadSource"
                aria-label="接收端下载源"
                [disabled]="downloading"
            >
                <option *ngFor="let source of builtinSources" [ngValue]="source.id">
                    {{ source.name }}
                </option>
                <option *ngFor="let source of draft.receiverCustomSources" [ngValue]="source.id">
                    {{ source.name }}
                </option>
            </select>
        </label>
        <section *ngFor="let source of draft.receiverCustomSources; let i = index">
            <label
                >下载源名称<input
                    class="form-control"
                    [(ngModel)]="source.name"
                    aria-label="下载源名称"
            /></label>
            <label
                >全平台压缩包地址<input
                    class="form-control"
                    [(ngModel)]="source.url"
                    placeholder="https://example.com/trzsz-v1.3.0-all-platform.tar.gz"
                    aria-label="全平台压缩包地址"
            /></label>
            <button
                class="btn btn-danger btn-sm"
                (click)="removeDownloadSource(i)"
                [disabled]="downloading"
            >
                删除下载源
            </button>
        </section>
        <button class="btn btn-secondary" (click)="addDownloadSource()" [disabled]="downloading">
            添加自定义下载源
        </button>
        <p class="text-muted">
            默认优先 GitHub，失败后尝试 Gitee。选择其他源后会优先使用该源，失败时尝试其余内置源。
            自定义地址需提供同一版本的全平台压缩包。
        </p>
        <button class="btn btn-secondary" (click)="predownload()" [disabled]="downloading">
            {{ downloading ? '正在预下载…' : '预下载接收端' }}
        </button>
        <button *ngIf="downloading" class="btn btn-secondary" (click)="cancelPredownload()">
            取消预下载
        </button>
        <p *ngIf="downloadStatus" role="status">{{ downloadStatus }}</p>
        <p *ngIf="downloadError" class="text-danger" role="alert">{{ downloadError }}</p>
        <label
            >远端工具目录<input
                class="form-control"
                [(ngModel)]="draft.receiverDirectory"
                placeholder="~/.local/bin"
                aria-label="远端工具目录"
        /></label>
        <p class="text-muted">
            默认 ~/.local/bin，支持以 / 或 ~/ 开头的目录。优先检测该目录中的 trz，再检查 PATH 中的
            trz。需要引导时将 trz、tsz 一起安装到该目录，目录不存在时自动创建， 并将其加入当前会话
            PATH。已有缓存时无需重复下载。
        </p>
        <h4>传输设置</h4>
        <label
            >接收端缓冲区大小（-B）<input
                class="form-control"
                [(ngModel)]="draft.receiverBufferSize"
                placeholder="10K"
                aria-label="接收端缓冲区大小"
        /></label>
        <p class="text-muted">
            默认 10K，范围 1K–1G，可填写字节数或使用 K、M、G 单位，例如 64K、1M。 用于引导安装 tsz
            和后续文件上传；中继链路会截断大消息时可调小。
        </p>
        <label
            >引导分块间隔（毫秒）<input
                class="form-control"
                type="number"
                min="0"
                max="1000"
                [(ngModel)]="draft.chunkDelayMs"
                aria-label="分块间隔"
        /></label>
        <p class="text-muted">默认 0，收到分块确认后立即继续；链路有粘贴限速时可增加。</p>
        <label
            >无响应超时（毫秒）<input
                class="form-control"
                type="number"
                min="1000"
                max="3600000"
                [(ngModel)]="draft.timeoutMs"
                aria-label="无响应超时"
        /></label>
        <p class="text-muted">
            远端至少需要 POSIX sh、mkdir、rm、mv、ln、wc；首次引导额外需要 chmod、uname；MIPS
            引导还需要 od 检测 ELF 端序。赋予文件执行权限时需要 chmod。stty
            可用时自动关闭回显并恢复。需要目录可写并允许执行上传程序。首次引导优先使用原生
            base64、cksum、cat 加速，缺少时回退到纯 Shell；逐块等待确认，耗时受文件体积、远端 CPU
            与链路延迟影响。
        </p>
        <p *ngIf="error" class="text-danger" role="alert">{{ error }}</p>
        <p *ngIf="saved" class="text-success" role="status">设置已保存</p>
        <button class="btn btn-primary" (click)="save()">保存设置</button>
    `,
    styles: [
        `
            :host {
                display: block;
                max-width: 900px;
            }
            h4 {
                margin-top: 1.8rem;
            }
            section {
                border: 1px solid var(--bs-border-color, #6666);
                border-radius: 6px;
                padding: 1rem;
                margin-bottom: 1rem;
            }
            label {
                display: block;
                margin-bottom: 0.7rem;
            }
            input.form-control {
                margin-top: 0.3rem;
            }
            .path-row {
                display: flex;
                align-items: baseline;
                gap: 0.5rem;
            }
            .path-row input {
                flex: 1;
                min-width: 0;
            }
            .path-row button {
                white-space: nowrap;
            }
            .options {
                display: flex;
                gap: 2rem;
            }
        `,
    ],
})
export class PushSettingsComponent implements OnDestroy {
    draft: PushSettings
    error = ''
    saved = false
    downloading = false
    downloadStatus = ''
    downloadError = ''
    private downloadController?: AbortController
    readonly builtinSources = RECEIVER_SOURCES
    readonly receiverArchive = RECEIVER_ARCHIVE
    readonly receiverVersion = RECEIVER_VERSION
    readonly receiverReleaseURL = RECEIVER_RELEASE_URL
    readonly receiverCachePath: string

    constructor(
        private config: ConfigService,
        private electron: ElectronService,
        private hostWindow: ElectronHostWindow,
        private platform: PlatformService,
        private receivers: ReceiverService,
    ) {
        this.draft = JSON.parse(
            JSON.stringify({ ...defaults, ...config.store.pushToolkit }),
        ) as PushSettings
        this.receiverCachePath = receiverCacheDirectory(platform.getConfigPath())
    }

    ngOnDestroy(): void {
        this.downloadController?.abort(new Error('预下载已取消。'))
    }

    addDownloadSource(): void {
        this.saved = false
        const id = randomBytes(8).toString('hex')
        this.draft.receiverCustomSources.push({ id, name: '自定义源', url: '' })
        this.draft.receiverDownloadSource = id
    }

    removeDownloadSource(index: number): void {
        const [removed] = this.draft.receiverCustomSources.splice(index, 1)
        if (removed?.id === this.draft.receiverDownloadSource)
            this.draft.receiverDownloadSource = 'github'
        this.saved = false
    }

    async openCacheDirectory(): Promise<void> {
        this.error = ''
        try {
            await fs.mkdir(this.receiverCachePath, { recursive: true })
            await this.platform.openPath(this.receiverCachePath)
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }

    async predownload(): Promise<void> {
        if (this.downloading) return
        this.downloading = true
        this.downloadStatus = '准备预下载…'
        this.downloadError = ''
        const controller = new AbortController()
        this.downloadController = controller
        try {
            await this.receivers.prefetch(this.draft, controller.signal, (status) => {
                this.downloadStatus = status
            })
            this.downloadStatus = '总包已展开，各平台压缩包已缓存，可离线使用。'
        } catch (error) {
            this.downloadStatus = ''
            this.downloadError = error instanceof Error ? error.message : String(error)
        } finally {
            this.downloading = false
            this.downloadController = undefined
        }
    }

    cancelPredownload(): void {
        this.downloadController?.abort(new Error('预下载已取消。'))
    }

    addFile(): void {
        this.saved = false
        this.draft.files.push({
            id: randomBytes(8).toString('hex'),
            name: '',
            localPath: '',
            remoteDirectory: '~/tools',
            remoteName: '',
            executable: false,
            overwrite: false,
        })
    }

    openRelease(event: Event): void {
        event.preventDefault()
        this.platform.openExternal(this.receiverReleaseURL)
    }

    async pickFile(item: { localPath: string }): Promise<void> {
        try {
            const result = await this.electron.dialog.showOpenDialog(this.hostWindow.getWindow(), {
                properties: ['openFile'],
                defaultPath: item.localPath || undefined,
            })
            if (!result.canceled && result.filePaths[0]) {
                item.localPath = result.filePaths[0]
                this.saved = false
            }
        } catch (error) {
            this.error = String(error)
        }
    }

    async save(): Promise<void> {
        this.error = ''
        this.saved = false
        try {
            validateSettings(this.draft)
            receiverLocation(this.draft.receiverDirectory)
            for (const file of this.draft.files) {
                if (!file.localPath.trim()) throw new Error('常用文件的本地路径不能为空。')
                remoteUploadDirectory(file.remoteDirectory)
                if (file.remoteName) validateName(file.remoteName)
            }
            // ConfigProxy structural sections are getter-only; update their leaf setters.
            // Clone the draft so later unsaved edits cannot mutate the live configuration.
            Object.assign(
                this.config.store.pushToolkit,
                JSON.parse(JSON.stringify(this.draft)) as PushSettings,
            )
            await this.config.save()
            this.saved = true
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
    }
}
