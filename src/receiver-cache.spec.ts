import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import * as path from 'path'
import * as os from 'os'
import { gzipSync } from 'zlib'
import { pack, Header } from 'tar-stream'
import {
    Download,
    extractTools,
    extractPlatformArchives,
    ReceiverCache,
    receiverAsset,
    receiverCacheDirectory,
} from './receiver-cache'
import { RECEIVER_ARCHIVE, RECEIVER_SOURCES } from './receiver-release'
import { RECEIVER_CHECKSUMS } from './receiver-checksums'

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function archive(
    entries: { header: Pick<Header, 'name'> & Partial<Header>; body?: Buffer }[],
): Promise<Buffer> {
    const tar = pack()
    const chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve, reject) => {
        tar.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)))
        tar.on('error', reject)
        tar.on('end', () => resolve(gzipSync(Buffer.concat(chunks))))
    })
    for (const entry of entries) tar.entry(entry.header, entry.body ?? Buffer.alloc(0))
    tar.finalize()
    return done
}

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cache-'))
    roots.push(root)
    const directory = receiverCacheDirectory(path.join(root, 'custom-profile', 'config.yaml'))
    const binary = {
        trz: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255]),
        tsz: Buffer.from('sender bytes'),
    }
    const nested = await archive([
        { header: { name: 'trzsz' }, body: Buffer.from('unused wrapper') },
        { header: { name: 'trz' }, body: binary.trz },
        { header: { name: 'tsz' }, body: binary.tsz },
    ])
    const filename = receiverAsset('Linux', 'x86_64')
    const otherFilename = receiverAsset('Darwin', 'arm64')
    const compressed = await archive([
        { header: { name: filename }, body: nested },
        { header: { name: otherFilename }, body: nested },
        { header: { name: 'checksums-sha256.txt' }, body: Buffer.from('untrusted manifest') },
    ])
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    const checksums = {
        [RECEIVER_ARCHIVE]: hash(compressed),
        [filename]: hash(nested),
        [otherFilename]: hash(nested),
    }
    const download = vi.fn<Download>(async (_url, signal) => {
        if (signal.aborted) throw signal.reason
        return compressed
    })
    return {
        root,
        directory,
        binary,
        otherFilename,
        compressed,
        filename,
        nested,
        checksums,
        download,
        cache: new ReceiverCache(directory, download, checksums),
    }
}

const signal = (): AbortSignal => new AbortController().signal
const status = (): void => undefined

describe('fixed release selection', () => {
    it.each([
        ['Linux', 'amd64', 'x86_64-unknown-linux-musl-upx'],
        ['Linux', 'arm64', 'aarch64-unknown-linux-musl-upx'],
        ['Linux', 'armv7l', 'armv7-unknown-linux-musleabihf-upx'],
        ['Linux', 'armv6l', 'arm-unknown-linux-musleabihf-upx'],
        ['Linux', 'i386', 'i686-unknown-linux-musl-upx'],
        ['Linux', 'mips', 'mips-unknown-linux-musl-upx'],
        ['Linux', 'mipsel', 'mipsel-unknown-linux-musl-upx'],
        ['Linux', 'ppc64le', 'powerpc64le-unknown-linux-musl-upx'],
        ['Linux', 's390x', 's390x-unknown-linux-musl'],
        ['Linux', 'riscv64', 'riscv64gc-unknown-linux-musl'],
        ['Darwin', 'arm64', 'aarch64-apple-darwin'],
    ])('selects %s/%s from v1.3.0', (platform, architecture, target) => {
        expect(receiverAsset(platform, architecture)).toBe(`trzsz-v1.3.0-${target}.tar.gz`)
    })

    it('rejects unsupported remote platforms and missing config locations', () => {
        expect(() => receiverAsset('Windows', 'x86_64')).toThrow('暂不支持')
        expect(() => receiverAsset('Linux', 'mips64')).toThrow('暂不支持')
        expect(() => receiverCacheDirectory(null)).toThrow('配置文件目录')
    })
})

describe('all-platform receiver cache', () => {
    it('downloads only the bundle, reuses it offline for other platforms after restart', async () => {
        const f = await fixture()
        expect(await f.cache.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(f.download).toHaveBeenCalledTimes(1)
        expect(f.download.mock.calls[0][0]).toBe(RECEIVER_SOURCES[0].url)
        expect(await fs.readFile(path.join(f.directory, RECEIVER_ARCHIVE))).toEqual(f.compressed)
        expect((await fs.readdir(f.directory)).sort()).toEqual(Object.keys(f.checksums).sort())
        const offline = vi.fn<Download>(async () => {
            throw new Error('Offline')
        })
        const restarted = new ReceiverCache(f.directory, offline, f.checksums)
        expect(await restarted.get('Darwin', 'arm64', signal(), status)).toEqual(f.binary)
        expect(offline).not.toHaveBeenCalled()
    })

    it('accepts a manually placed bundle and ignores any cached checksum manifest', async () => {
        const f = await fixture()
        await fs.mkdir(f.directory, { recursive: true })
        await fs.writeFile(path.join(f.directory, RECEIVER_ARCHIVE), f.compressed)
        await fs.writeFile(path.join(f.directory, 'checksums-sha256.txt'), 'not trusted')
        await f.cache.prefetch(signal(), status)
        expect(await f.cache.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(f.download).not.toHaveBeenCalled()
    })

    it('prefetches and verifies every platform archive alongside the complete bundle', async () => {
        const f = await fixture()
        await f.cache.prefetch(signal(), status)
        expect(await fs.readFile(path.join(f.directory, RECEIVER_ARCHIVE))).toEqual(f.compressed)
        expect(f.download).toHaveBeenCalledTimes(1)
        expect((await fs.readdir(f.directory)).sort()).toEqual(Object.keys(f.checksums).sort())
        expect(await fs.readFile(path.join(f.directory, f.filename))).toEqual(f.nested)
        expect(await fs.readFile(path.join(f.directory, f.otherFilename))).toEqual(f.nested)
    })

    it('uses individual platform archives without reading or extracting the bundle again', async () => {
        const f = await fixture()
        await f.cache.prefetch(signal(), status)
        await fs.rm(path.join(f.directory, RECEIVER_ARCHIVE))
        const offline = vi.fn<Download>(async () => {
            throw new Error('Must use platform cache')
        })
        const restarted = new ReceiverCache(f.directory, offline, f.checksums)
        expect(await restarted.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(await restarted.get('Darwin', 'arm64', signal(), status)).toEqual(f.binary)
        await restarted.prefetch(signal(), status)
        expect(offline).not.toHaveBeenCalled()
        await expect(fs.stat(path.join(f.directory, RECEIVER_ARCHIVE))).rejects.toThrow()
    })

    it('accepts a manually placed platform archive without downloading the bundle', async () => {
        const f = await fixture()
        await fs.mkdir(f.directory, { recursive: true })
        await fs.writeFile(path.join(f.directory, f.filename), f.nested)
        expect(await f.cache.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(f.download).not.toHaveBeenCalled()
        expect(await fs.readdir(f.directory)).toEqual([f.filename])
    })

    it('repairs missing or corrupt platform archives from the cached bundle without downloading', async () => {
        const f = await fixture()
        await f.cache.prefetch(signal(), status)
        await fs.writeFile(path.join(f.directory, f.filename), 'corrupt platform cache')
        await fs.rm(path.join(f.directory, f.otherFilename))
        expect(await f.cache.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(await f.cache.get('Darwin', 'arm64', signal(), status)).toEqual(f.binary)
        expect(f.download).toHaveBeenCalledOnce()
        expect(await fs.readFile(path.join(f.directory, f.filename))).toEqual(f.nested)
        expect(await fs.readFile(path.join(f.directory, f.otherFilename))).toEqual(f.nested)
    })

    it('never publishes platform archives before all nested checksums pass', async () => {
        const f = await fixture()
        const cache = new ReceiverCache(f.directory, f.download, {
            ...f.checksums,
            [f.otherFilename]: '0'.repeat(64),
        })
        await expect(cache.prefetch(signal(), status)).rejects.toThrow('SHA-256')
        expect(await fs.readdir(f.directory)).toEqual([RECEIVER_ARCHIVE])
    })

    it('redownloads a corrupted manually placed bundle', async () => {
        const f = await fixture()
        await fs.mkdir(f.directory, { recursive: true })
        await fs.writeFile(path.join(f.directory, RECEIVER_ARCHIVE), 'corrupt cache')
        expect(await f.cache.get('Linux', 'x86_64', signal(), status)).toEqual(f.binary)
        expect(f.download).toHaveBeenCalledOnce()
    })

    it('tries the backup when the preferred source cannot connect', async () => {
        const f = await fixture()
        f.download.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
        await f.cache.prefetch(signal(), status)
        expect(f.download.mock.calls.map(([url]) => url)).toEqual(
            RECEIVER_SOURCES.map((source) => source.url),
        )
    })

    it('rejects corrupt downloads and tries the next source before publishing', async () => {
        const f = await fixture()
        f.download.mockResolvedValueOnce(Buffer.from('bad bytes'))
        await f.cache.prefetch(signal(), status)
        expect(f.download).toHaveBeenCalledTimes(2)
        expect(await fs.readFile(path.join(f.directory, RECEIVER_ARCHIVE))).toEqual(f.compressed)
    })

    it('reports all source failures and never caches unverified bytes', async () => {
        const f = await fixture()
        f.download.mockResolvedValue(Buffer.from('bad bytes'))
        await expect(f.cache.prefetch(signal(), status)).rejects.toThrow(
            /github.com.*SHA-256[\s\S]*gitee.com.*SHA-256/,
        )
        expect(await fs.readdir(f.directory)).toEqual([])
    })

    it('reports local cache write errors without retrying another download source', async () => {
        const f = await fixture()
        await fs.mkdir(path.join(f.directory, RECEIVER_ARCHIVE), { recursive: true })
        await expect(f.cache.prefetch(signal(), status)).rejects.toThrow()
        expect(f.download).toHaveBeenCalledOnce()
        expect(await fs.readdir(f.directory)).toEqual([RECEIVER_ARCHIVE])
    })

    it('honors selected and custom source ordering', async () => {
        const f = await fixture()
        const urls = ['https://mirror.example.com/bundle.tar.gz', RECEIVER_SOURCES[1].url]
        await f.cache.prefetch(signal(), status, urls)
        expect(f.download.mock.calls.map(([url]) => url)).toEqual([urls[0]])
    })

    it('shares a single download across prefetch and different remote platforms', async () => {
        const f = await fixture()
        const results = await Promise.all([
            f.cache.prefetch(signal(), status),
            f.cache.get('Linux', 'x86_64', signal(), status),
            f.cache.get('Darwin', 'arm64', signal(), status),
        ])
        expect(results).toEqual([undefined, f.binary, f.binary])
        expect(f.download).toHaveBeenCalledOnce()
    })

    it('cancels one waiter without cancelling a shared download', async () => {
        const f = await fixture()
        let release!: () => void
        let started!: () => void
        const ready = new Promise<void>((resolve) => {
            started = resolve
        })
        const wait = new Promise<void>((resolve) => {
            release = resolve
        })
        f.download.mockImplementation(async (_url, downloadSignal) => {
            started()
            await wait
            expect(downloadSignal.aborted).toBe(false)
            return f.compressed
        })
        const cancelled = new AbortController()
        const first = f.cache.prefetch(cancelled.signal, status)
        const second = f.cache.get('Linux', 'x86_64', signal(), status)
        await ready
        cancelled.abort(new Error('Cancelled prefetch'))
        await expect(first).rejects.toThrow('Cancelled prefetch')
        release()
        expect(await second).toEqual(f.binary)
        expect(f.download).toHaveBeenCalledOnce()
    })

    it('cancels an unused download without falling back or leaving partial files', async () => {
        const f = await fixture()
        let started!: () => void
        const ready = new Promise<void>((resolve) => {
            started = resolve
        })
        const abortRequest = vi.fn()
        f.download.mockImplementation(
            async (_url, downloadSignal) =>
                new Promise((_resolve, reject) => {
                    downloadSignal.addEventListener(
                        'abort',
                        () => {
                            abortRequest()
                            reject(new Error('Aborted'))
                        },
                        { once: true },
                    )
                    started()
                }),
        )
        const controller = new AbortController()
        const pending = f.cache.prefetch(controller.signal, status)
        await ready
        controller.abort()
        await expect(pending).rejects.toThrow()
        expect(abortRequest).toHaveBeenCalledOnce()
        expect(f.download).toHaveBeenCalledOnce()
        expect(await fs.readdir(f.directory)).toEqual([])
    })

    it.skipIf(!process.env.TRZ_ALL_ARCHIVE)(
        'verifies the real all-platform release using embedded checksums',
        async () => {
            const f = await fixture()
            const archivePath = process.env.TRZ_ALL_ARCHIVE
            if (!archivePath) throw new Error('Missing all-platform release fixture')
            const bundle = await fs.readFile(archivePath)
            const cache = new ReceiverCache(f.directory, async () => bundle)
            await cache.prefetch(signal(), status)
            expect((await fs.readdir(f.directory)).sort()).toEqual(
                Object.keys(RECEIVER_CHECKSUMS).sort(),
            )
            await fs.rm(path.join(f.directory, RECEIVER_ARCHIVE))
            for (const [platform, arch] of [
                ['Linux', 'x86_64'],
                ['Linux', 'aarch64'],
                ['Darwin', 'arm64'],
            ]) {
                const binaries = await cache.get(platform, arch, signal(), status)
                expect(binaries.trz.length).toBeGreaterThan(10000)
                expect(binaries.tsz.length).toBeGreaterThan(10000)
            }
            expect(createHash('sha256').update(bundle).digest('hex')).toBe(
                RECEIVER_CHECKSUMS[RECEIVER_ARCHIVE],
            )
        },
    )
})

describe('local archive extraction', () => {
    it('does not accept symlinks, duplicate receivers or missing receiver entries', async () => {
        const link = await archive([
            { header: { name: 'trz', type: 'symlink', linkname: '/usr/bin/sh' } },
        ])
        await expect(extractTools(link)).rejects.toThrow('普通文件')
        const duplicate = await archive([
            { header: { name: 'trz' }, body: Buffer.from('a') },
            { header: { name: 'trz' }, body: Buffer.from('b') },
        ])
        await expect(extractTools(duplicate)).rejects.toThrow('唯一')
        const escaped = await archive([{ header: { name: '../../trz' }, body: Buffer.from('bad') }])
        await expect(extractTools(escaped)).rejects.toThrow('没有有效')
    })

    it('requires both tools and rejects an unsafe sender entry', async () => {
        const receiverOnly = await archive([
            { header: { name: 'trz' }, body: Buffer.from('receiver') },
        ])
        await expect(extractTools(receiverOnly)).rejects.toThrow('trz 或 tsz')
        const senderLink = await archive([
            { header: { name: 'trz' }, body: Buffer.from('receiver') },
            { header: { name: 'tsz', type: 'symlink', linkname: '/bin/sh' } },
        ])
        await expect(extractTools(senderLink)).rejects.toThrow('普通文件')
    })
})

describe('nested platform archive verification', () => {
    it('requires a unique regular platform archive and verifies it against the embedded list', async () => {
        const f = await fixture()
        const missing = await archive([{ header: { name: '../../' + f.filename }, body: f.nested }])
        await expect(extractPlatformArchives(missing, f.checksums)).rejects.toThrow('缺少')
        const duplicate = await archive([
            { header: { name: f.filename }, body: f.nested },
            { header: { name: f.filename }, body: f.nested },
        ])
        await expect(extractPlatformArchives(duplicate, f.checksums)).rejects.toThrow('唯一')
        await expect(
            extractPlatformArchives(f.compressed, {
                ...f.checksums,
                [f.filename]: '0'.repeat(64),
            }),
        ).rejects.toThrow('SHA-256')
    })
})
