export interface SavedFile {
    id: string
    name: string
    localPath: string
    remoteDirectory: string
    remoteName: string
    executable: boolean
    overwrite: boolean
}

export interface Receiver {
    id: string
    platform: string
    architecture: string
    localPath: string
    note: string
}

export interface PushSettings {
    files: SavedFile[]
    receivers: Receiver[]
    receiverPath: string
    chunkDelayMs: number
    timeoutMs: number
}

export const DEFAULT_BOOTSTRAP_PATH = '~/.local/lib/tabby-push-toolkit/trz'

export const defaults: PushSettings = {
    files: [],
    receivers: [],
    receiverPath: 'trz',
    chunkDelayMs: 10,
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

export function selectReceiver(
    receivers: Receiver[],
    platform: string,
    architecture: string,
): Receiver {
    const candidates = receivers.filter(
        (r) =>
            !!r.localPath.trim() &&
            r.platform.trim().toLowerCase() === platform.toLowerCase() &&
            canonicalArchitecture(r.architecture) === canonicalArchitecture(architecture),
    )
    if (candidates.length !== 1) {
        throw new Error(
            `未找到可用的已安装 trz，且远端平台 ${platform}/${architecture} 有 ${candidates.length} 个匹配的引导文件。请设置已安装 trz 的路径，或配置唯一匹配的本地接收端文件。`,
        )
    }
    return candidates[0]
}

export function validateName(name: string): string {
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) {
        throw new Error('目标文件名必须是单个文件名，不能包含斜线或控制字符。')
    }
    return name
}

export function validateSettings(settings: PushSettings): void {
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
    const platforms = new Set<string>()
    for (const receiver of settings.receivers) {
        if (!receiver.localPath.trim()) continue
        const key = `${receiver.platform.trim().toLowerCase()}/${canonicalArchitecture(receiver.architecture)}`
        if (platforms.has(key)) throw new Error(`接收端配置重复：${key}`)
        platforms.add(key)
    }
}
