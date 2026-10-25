import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { ElectronHostWindow, ElectronService } from 'tabby-electron'
import { randomBytes } from 'crypto'
import { defaults, PushSettings, validateName, validateSettings } from './models'
import { remotePath, receiverLocation } from './shell'

@Component({
    host: { '(input)': 'saved = false', '(change)': 'saved = false' },
    template: `
        <h3>Push Toolkit</h3>
        <p class="text-muted">
            通过当前 SSH 终端推送常用文件。请在远端 Shell
            空闲提示符下操作；上传期间输入会被接管，Ctrl+C 可取消。
        </p>
        <p class="text-muted">
            已包含 tabby-trzsz，无需另外安装。优先使用远端已安装的
            trz；仅在远端没有可用接收端时，才需要配置本地引导文件。
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
                    placeholder="~/tools"
                    aria-label="远端目录"
            /></label>
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

        <h4>引导接收端（可选）</h4>
        <p class="text-muted">
            远端已经安装 trz 时可以跳过本节。需要引导时，按远端 uname -s / uname -m
            匹配，不能使用本机架构代替。每个平台与架构只能配置一个接收端。上传的是 trz
            可执行文件，不是 tar.gz 压缩包，也不是 trzsz 包装程序。
        </p>
        <section *ngFor="let receiver of draft.receivers; let i = index">
            <label
                >平台<input
                    class="form-control"
                    [(ngModel)]="receiver.platform"
                    placeholder="Linux"
                    aria-label="接收端平台"
            /></label>
            <label
                >架构<input
                    class="form-control"
                    [(ngModel)]="receiver.architecture"
                    placeholder="x86_64 / aarch64 / armv7l"
                    aria-label="接收端架构"
            /></label>
            <label
                >本地 trz 文件
                <div class="path-row">
                    <input
                        class="form-control"
                        [(ngModel)]="receiver.localPath"
                        aria-label="本地接收端"
                    /><button class="btn btn-secondary" (click)="pickFile(receiver)">浏览…</button>
                </div></label
            >
            <label
                >备注<input
                    class="form-control"
                    [(ngModel)]="receiver.note"
                    placeholder="例如 Linux x86_64 musl 静态版"
                    aria-label="接收端备注"
            /></label>
            <button class="btn btn-danger btn-sm" (click)="draft.receivers.splice(i, 1)">
                删除接收端
            </button>
        </section>
        <button class="btn btn-secondary" (click)="addReceiver()">添加接收端</button>

        <h4>传输设置</h4>
        <label
            >远端 trz 命令或路径<input
                class="form-control"
                [(ngModel)]="draft.receiverPath"
                placeholder="trz（留空自动检测）"
                aria-label="远端接收端路径"
        /></label>
        <p class="text-muted">
            支持 trz、/usr/local/bin/trz、~/bin/trz。先检查指定命令或路径，再查找 PATH 中的 trz
            和工具包已引导的接收端；这些都不可用时才使用本地引导文件。
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
            远端至少需要 POSIX sh、mkdir、rm、mv、ln、wc；首次引导额外需要
            chmod、uname，赋予文件执行权限时需要 chmod。stty
            可用时自动关闭回显并恢复。需要目录可写并允许执行上传程序。首次引导使用纯 Shell
            解码和逐块确认，耗时取决于接收端体积与链路延迟。
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
export class PushSettingsComponent {
    draft: PushSettings
    error = ''
    saved = false

    constructor(
        private config: ConfigService,
        private electron: ElectronService,
        private hostWindow: ElectronHostWindow,
    ) {
        this.draft = JSON.parse(
            JSON.stringify({ ...defaults, ...config.store.pushToolkit }),
        ) as PushSettings
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

    addReceiver(): void {
        this.saved = false
        this.draft.receivers.push({
            id: randomBytes(8).toString('hex'),
            platform: 'Linux',
            architecture: '',
            localPath: '',
            note: '',
        })
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
            receiverLocation(this.draft.receiverPath)
            for (const file of this.draft.files) {
                if (!file.localPath.trim()) throw new Error('常用文件的本地路径不能为空。')
                remotePath(file.remoteDirectory)
                if (file.remoteName) validateName(file.remoteName)
            }
            for (const receiver of this.draft.receivers) {
                if (!receiver.localPath.trim()) continue
                if (!receiver.platform.trim() || !receiver.architecture.trim())
                    throw new Error('选择本地引导文件后，请填写对应的平台和架构。')
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
