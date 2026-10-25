import { RECEIVER_SOURCES, ReceiverDownloadSource } from './receiver-release'

export interface SavedFile {
    id: string
    name: string
    localPath: string
    remoteDirectory: string
    remoteName: string
    executable: boolean
    overwrite: boolean
}

export interface PushSettings {
    files: SavedFile[]
    receiverDirectory: string
    receiverDownloadSource: string
    receiverCustomSources: ReceiverDownloadSource[]
    receiverBufferSize: string
    chunkDelayMs: number
    timeoutMs: number
}

export const DEFAULT_RECEIVER_DIRECTORY = '~/.local/bin'

export const defaults: PushSettings = {
    files: [],
    receiverDirectory: DEFAULT_RECEIVER_DIRECTORY,
    receiverDownloadSource: 'github',
    receiverCustomSources: [],
    receiverBufferSize: '10K',
    chunkDelayMs: 0,
    timeoutMs: 60000,
}

export function canonicalArchitecture(value: string): string {
    const arch = value.trim().toLowerCase()
    return (
        (
            { amd64: 'x86_64', arm64: 'aarch64', armv7: 'armv7l', x86: 'i686' } as Record<
                string,
                string
            >
        )[arch] ?? arch
    )
}

export function validateName(name: string): string {
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) {
        throw new Error('目标文件名必须是单个文件名，不能包含斜线或控制字符。')
    }
    return name
}

export function validateReceiverBufferSize(value: string): string {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : ''
    const match = /^(\d+)([KMG]?)$/.exec(normalized)
    const bytes = match ? Number(match[1]) * 1024 ** ['', 'K', 'M', 'G'].indexOf(match[2]) : NaN
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 1024 ** 3) {
        throw new Error('接收端缓冲区大小必须为 1K–1G，可填写字节数或使用 K、M、G 单位，例如 10K。')
    }
    return normalized
}

export function validateSettings(settings: PushSettings): void {
    receiverDownloadURLs(settings)
    validateReceiverBufferSize(settings.receiverBufferSize)
    if (
        !Number.isInteger(settings.chunkDelayMs) ||
        settings.chunkDelayMs < 0 ||
        settings.chunkDelayMs > 1000
    ) {
        throw new Error('分块间隔必须为 0–1000 毫秒。')
    }
    if (
        !Number.isInteger(settings.timeoutMs) ||
        settings.timeoutMs < 1000 ||
        settings.timeoutMs > 3600000
    ) {
        throw new Error('阶段超时必须为 1000–3600000 毫秒。')
    }
}
export type ReceiverSourceSettings = Pick<
    PushSettings,
    'receiverDownloadSource' | 'receiverCustomSources'
>

export function receiverDownloadURLs(settings: ReceiverSourceSettings): string[] {
    const ids = new Set(RECEIVER_SOURCES.map((source) => source.id))
    for (const source of settings.receiverCustomSources) {
        if (!source.id || ids.has(source.id)) throw new Error('下载源标识不能重复。')
        ids.add(source.id)
        if (!source.name.trim()) throw new Error('请填写自定义下载源名称。')
        let url: URL
        try {
            url = new URL(source.url)
        } catch {
            throw new Error('自定义下载源必须填写完整的 HTTP 或 HTTPS 压缩包地址。')
        }
        if (!['http:', 'https:'].includes(url.protocol))
            throw new Error('自定义下载源仅支持 HTTP 或 HTTPS 地址。')
    }
    const selected = [...RECEIVER_SOURCES, ...settings.receiverCustomSources].find(
        (source) => source.id === settings.receiverDownloadSource,
    )
    if (!selected) throw new Error('请选择有效的接收端下载源。')
    return [...new Set([selected.url, ...RECEIVER_SOURCES.map((source) => source.url)])]
}
