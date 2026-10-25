import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { EventEmitter } from 'events'
import { electronDownloader } from './download'
import { Download, ReceiverBinaries, receiverCacheDirectory } from './receiver-cache'
import { defaults, receiverDownloadURLs } from './models'
import { RECEIVER_SOURCES } from './receiver-release'

describe('receiver service host networking', () => {
    it('uses the host remote bridge without relying on ElectronService.remote', async () => {
        const request = Object.assign(new EventEmitter(), {
            end: vi.fn(() => {
                const response = Object.assign(new EventEmitter(), { statusCode: 200 })
                request.emit('response', response)
                response.emit('data', Buffer.from('downloaded'))
                response.emit('end')
            }),
            abort: vi.fn(),
            setHeader: vi.fn(),
        })
        const net = { request: vi.fn((_options: { url: string }) => request) }
        const directories: string[] = []
        const binaries = { trz: Buffer.from('trz'), tsz: Buffer.from('tsz') }
        class Cache {
            constructor(
                directory: string,
                private download: Download,
            ) {
                directories.push(directory)
            }
            async prefetch(signal: AbortSignal, _status: unknown, sources: string[]) {
                expect(await this.download(sources[0], signal, 100)).toEqual(
                    Buffer.from('downloaded'),
                )
            }
            async get(
                _platform: string,
                _architecture: string,
                signal: AbortSignal,
                status: unknown,
                sources: string[],
            ) {
                await this.prefetch(signal, status, sources)
                return binaries
            }
        }
        const hostRequire = vi.fn((name: string) => {
            switch (name) {
                case '@angular/core':
                    return { Injectable: () => (target: unknown) => target }
                case 'tabby-core':
                    return {}
                case './receiver-cache':
                    return { ReceiverCache: Cache, receiverCacheDirectory }
                case './models':
                    return { receiverDownloadURLs }
                case './download':
                    return { electronDownloader }
                case '@electron/remote':
                    return { net }
                default:
                    throw new Error(`Unexpected host dependency: ${name}`)
            }
        })
        // Evaluate the service's real implementation with Tabby's host module
        // contract. A fake ElectronService.remote would hide the reported crash.
        const source = readFileSync(new URL('./receiver.service.ts', import.meta.url), 'utf8')
        const { outputText } = transpileModule(source, {
            compilerOptions: {
                module: ModuleKind.CommonJS,
                target: ScriptTarget.ES2020,
                experimentalDecorators: true,
            },
        })
        const module = { exports: {} } as {
            exports: {
                ReceiverService: new (platform: { getConfigPath(): string }) => {
                    load(...args: unknown[]): Promise<ReceiverBinaries>
                    prefetch(...args: unknown[]): Promise<void>
                }
            }
        }
        runInNewContext(outputText, { module, exports: module.exports, require: hostRequire })
        const service = new module.exports.ReceiverService({
            getConfigPath: () => '/tmp/tabby/config.yaml',
        })
        const signal = new AbortController().signal
        expect(await service.load('Linux', 'x86_64', signal, () => undefined, defaults)).toEqual(
            binaries,
        )
        await service.prefetch(
            { ...defaults, receiverDownloadSource: 'gitee' },
            signal,
            () => undefined,
        )
        expect(directories).toEqual(['/tmp/tabby/push-toolkit/receivers/v1.3.0'])
        expect(hostRequire.mock.calls.filter(([name]) => name === '@electron/remote')).toHaveLength(
            1,
        )
        expect(net.request.mock.calls.map(([options]) => options.url)).toEqual(
            RECEIVER_SOURCES.map((source) => source.url),
        )
    })
})
