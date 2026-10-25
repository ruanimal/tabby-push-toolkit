import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash, randomBytes } from 'crypto'
import { createGunzip } from 'zlib'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { extract } from 'tar-stream'
import { canonicalArchitecture } from './models'
import { RECEIVER_ARCHIVE, RECEIVER_SOURCES, RECEIVER_VERSION } from './receiver-release'
import { RECEIVER_CHECKSUMS } from './receiver-checksums'

export { RECEIVER_VERSION, RECEIVER_RELEASE_URL } from './receiver-release'
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024

export type Download = (url: string, signal: AbortSignal, limit: number) => Promise<Buffer>
export type ReceiverStatus = (message: string) => void
export interface ReceiverBinaries {
    trz: Buffer
    tsz: Buffer
}

export function receiverCacheDirectory(configPath: string | null): string {
    if (!configPath || !path.isAbsolute(configPath))
        throw new Error('无法确定 Tabby 配置文件目录。')
    return path.join(path.dirname(configPath), 'push-toolkit', 'receivers', RECEIVER_VERSION)
}

/** Assets verified against the fixed release. Linux always uses static musl builds. */
export function receiverAsset(platform: string, architecture: string): string {
    const arch = canonicalArchitecture(architecture)
    let target: string | undefined
    let packed = false
    if (platform.toLowerCase() === 'linux') {
        const targets: Record<string, string> = {
            x86_64: 'x86_64-unknown-linux-musl',
            aarch64: 'aarch64-unknown-linux-musl',
            armv7l: 'armv7-unknown-linux-musleabihf',
            armv6l: 'arm-unknown-linux-musleabihf',
            i386: 'i686-unknown-linux-musl',
            i486: 'i686-unknown-linux-musl',
            i586: 'i686-unknown-linux-musl',
            i686: 'i686-unknown-linux-musl',
            mips: 'mips-unknown-linux-musl',
            mipsel: 'mipsel-unknown-linux-musl',
            ppc64le: 'powerpc64le-unknown-linux-musl',
            powerpc64le: 'powerpc64le-unknown-linux-musl',
            s390x: 's390x-unknown-linux-musl',
            riscv64: 'riscv64gc-unknown-linux-musl',
        }
        target = targets[arch]
        packed = arch !== 's390x' && arch !== 'riscv64'
    } else if (platform.toLowerCase() === 'darwin' && ['x86_64', 'aarch64'].includes(arch)) {
        target = `${arch}-apple-darwin`
    }
    if (!target)
        throw new Error(
            `trzsz-rs ${RECEIVER_VERSION} 暂不支持自动引导 ${platform}/${architecture}，请先在远端安装兼容的 trz。`,
        )
    return `trzsz-${RECEIVER_VERSION}-${target}${packed ? '-upx' : ''}.tar.gz`
}

const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export function cancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('已取消接收端下载。')
}

function checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw cancellationError(signal)
}

function awaitWithCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancellationError(signal))
    return new Promise((resolve, reject) => {
        const abort = (): void => reject(cancellationError(signal))
        signal.addEventListener('abort', abort, { once: true })
        void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}

async function extractEntries(archive: Buffer, names: string[]): Promise<Map<string, Buffer>> {
    const tar = extract()
    const entries = new Map<string, Buffer>()
    const found = new Set<string>()
    let total = 0
    const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            total += chunk.length
            callback(
                total > MAX_UNPACKED_BYTES ? new Error('压缩包解压后超过大小限制。') : null,
                chunk,
            )
        },
    })
    tar.on('entry', (header, stream, next) => {
        stream.on('error', (error) => tar.destroy(error))
        const name = header.name.replace(/^\.\//, '')
        const wanted = names.includes(name)
        if (
            wanted &&
            (found.has(name) || header.type !== 'file' || (header.size ?? 0) > MAX_ARCHIVE_BYTES)
        ) {
            tar.destroy(new Error(`压缩包中的 ${name} 必须是唯一的普通文件。`))
            return
        }
        if (wanted) found.add(name)
        const chunks: Buffer[] = []
        stream.on('data', (chunk) => {
            if (wanted) chunks.push(Buffer.from(chunk as Uint8Array))
        })
        stream.on('end', () => {
            if (wanted) entries.set(name, Buffer.concat(chunks))
            next()
        })
        stream.resume()
    })
    await pipeline(Readable.from(archive), createGunzip(), limit, tar)
    return entries
}

export async function extractTools(archive: Buffer): Promise<ReceiverBinaries> {
    const entries = await extractEntries(archive, ['trz', 'tsz'])
    const trz = entries.get('trz'),
        tsz = entries.get('tsz')
    if (!trz?.length || !tsz?.length) throw new Error('发行压缩包中没有有效的 trz 或 tsz。')
    return { trz, tsz }
}

export async function extractPlatformArchives(
    archive: Buffer,
    checksums: Readonly<Record<string, string>> = RECEIVER_CHECKSUMS,
): Promise<Map<string, Buffer>> {
    const filenames = Object.keys(checksums).filter((name) => name !== RECEIVER_ARCHIVE)
    const entries = await extractEntries(archive, filenames)
    for (const filename of filenames) {
        const nested = entries.get(filename)
        if (!nested?.length) throw new Error(`全平台压缩包中缺少 ${filename}。`)
        if (digest(nested) !== checksums[filename])
            throw new Error(`平台压缩包 ${filename} SHA-256 校验失败。`)
    }
    return entries
}

interface PendingPreparation {
    controller: AbortController
    promise: Promise<void>
    users: number
    settled: boolean
    listeners: Set<ReceiverStatus>
}

/** Cache only verified compressed archives. Extraction never executes downloaded code locally. */
export class ReceiverCache {
    private pending = new Map<string, PendingPreparation>()

    constructor(
        readonly directory: string,
        private download: Download,
        private checksums: Readonly<Record<string, string>> = RECEIVER_CHECKSUMS,
    ) {}

    async get(
        platform: string,
        architecture: string,
        signal: AbortSignal,
        status: ReceiverStatus,
        sources: string[] = RECEIVER_SOURCES.map((source) => source.url),
    ): Promise<ReceiverBinaries> {
        const filename = receiverAsset(platform, architecture)
        checkCancelled(signal)
        let archive = await this.readPlatformArchive(filename)
        if (!archive) {
            await this.prepare(signal, status, sources)
            archive = await this.readPlatformArchive(filename)
        }
        checkCancelled(signal)
        if (!archive) throw new Error(`平台压缩包 ${filename} 未正确缓存。`)
        status(`从平台缓存提取 ${platform}/${architecture} 接收端…`)
        return extractTools(archive)
    }

    async prefetch(
        signal: AbortSignal,
        status: ReceiverStatus,
        sources: string[] = RECEIVER_SOURCES.map((source) => source.url),
    ): Promise<void> {
        await this.prepare(signal, status, sources)
    }

    private async prepare(
        signal: AbortSignal,
        status: ReceiverStatus,
        sources: string[],
    ): Promise<void> {
        checkCancelled(signal)
        if (!sources.length) throw new Error('没有可用的接收端下载源。')
        status(`准备 trzsz-rs ${RECEIVER_VERSION} 全平台接收端…`)
        const key = sources.join('\n')
        let job = this.pending.get(key)
        if (!job) {
            const controller = new AbortController()
            job = {
                controller,
                users: 0,
                settled: false,
                promise: Promise.resolve(),
                listeners: new Set(),
            }
            const current = job
            job.promise = this.prepareArchives(sources, controller.signal, (message) => {
                for (const listener of current.listeners) listener(message)
            }).finally(() => {
                current.settled = true
                if (this.pending.get(key) === current) this.pending.delete(key)
            })
            this.pending.set(key, job)
        }
        job.users++
        const report: ReceiverStatus = (message) => status(message)
        job.listeners.add(report)
        try {
            return await awaitWithCancellation(job.promise, signal)
        } finally {
            job.users--
            job.listeners.delete(report)
            if (!job.users && !job.settled) {
                job.controller.abort()
                if (this.pending.get(key) === job) this.pending.delete(key)
            }
        }
    }

    private async readPlatformArchive(filename: string): Promise<Buffer | undefined> {
        const archive = await this.read(path.join(this.directory, filename), MAX_ARCHIVE_BYTES)
        return archive && this.checksums[filename] && digest(archive) === this.checksums[filename]
            ? archive
            : undefined
    }

    private async prepareArchives(
        sources: string[],
        signal: AbortSignal,
        status: ReceiverStatus,
    ): Promise<void> {
        const filenames = Object.keys(this.checksums).filter((name) => name !== RECEIVER_ARCHIVE)
        const cached = new Set<string>()
        for (const filename of filenames) {
            checkCancelled(signal)
            if (await this.readPlatformArchive(filename)) cached.add(filename)
        }
        if (cached.size === filenames.length) {
            status('所有平台压缩包均已缓存并通过校验。')
            return
        }
        const bundle = await this.load(sources, signal, status)
        checkCancelled(signal)
        status('解压全平台包并校验各平台压缩包…')
        // Verify every expected platform before publishing any newly extracted archive.
        const entries = await extractPlatformArchives(bundle, this.checksums)
        let completed = 0
        for (const [filename, archive] of entries) {
            checkCancelled(signal)
            if (!cached.has(filename))
                await this.publish(path.join(this.directory, filename), archive, signal)
            status(`缓存各平台压缩包 ${++completed}/${filenames.length}`)
        }
        status('总包已展开，各平台压缩包已缓存。')
    }

    private async read(filename: string, limit: number): Promise<Buffer | undefined> {
        try {
            const info = await fs.stat(filename)
            if (!info.isFile() || info.size > limit) return undefined
            return await fs.readFile(filename)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
        }
    }

    private async publish(filename: string, data: Buffer, signal: AbortSignal): Promise<void> {
        checkCancelled(signal)
        const temporary = `${filename}.${randomBytes(8).toString('hex')}.part`
        try {
            await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
            checkCancelled(signal)
            await fs.rename(temporary, filename)
        } finally {
            await fs.rm(temporary, { force: true })
        }
    }

    private async load(
        sources: string[],
        signal: AbortSignal,
        status: ReceiverStatus,
    ): Promise<Buffer> {
        await fs.mkdir(this.directory, { recursive: true })
        const expected = this.checksums[RECEIVER_ARCHIVE]
        if (!expected) throw new Error('插件内置校验清单缺少全平台压缩包校验值。')
        checkCancelled(signal)
        const archivePath = path.join(this.directory, RECEIVER_ARCHIVE)
        const archive = await this.read(archivePath, MAX_ARCHIVE_BYTES)
        if (archive && digest(archive) === expected) {
            status(`使用缓存 ${RECEIVER_ARCHIVE}`)
            return archive
        }
        const failures: string[] = []
        for (const source of [...new Set(sources)]) {
            checkCancelled(signal)
            const host = new URL(source).host
            status(`从 ${host} 下载全平台接收端…`)
            let downloaded: Buffer
            try {
                downloaded = await this.download(source, signal, MAX_ARCHIVE_BYTES)
                checkCancelled(signal)
                if (digest(downloaded) !== expected)
                    throw new Error('全平台压缩包 SHA-256 校验失败，未写入缓存。')
            } catch (error) {
                checkCancelled(signal)
                failures.push(`${host}：${error instanceof Error ? error.message : String(error)}`)
                continue
            }
            // A local write failure cannot be fixed by downloading from another mirror.
            await this.publish(archivePath, downloaded, signal)
            status('全平台接收端已下载并通过校验。')
            return downloaded
        }
        throw new Error(`接收端下载失败，所有下载源均不可用：\n${failures.join('\n')}`)
    }
}
