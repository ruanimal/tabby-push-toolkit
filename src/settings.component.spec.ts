import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import type { ConfigService, PlatformService } from 'tabby-core'
import type { ElectronHostWindow, ElectronService } from 'tabby-electron'
import { defaults, PushSettings, receiverDownloadURLs } from './models'
import { RECEIVER_SOURCES } from './receiver-release'
import type { ReceiverService } from './receiver.service'
import { PushSettingsComponent } from './settings.component'

vi.mock('@angular/core', () => ({ Component: () => (target: unknown) => target }))
vi.mock('tabby-core', () => ({ ConfigService: class {}, PlatformService: class {} }))
vi.mock('tabby-electron', () => ({ ElectronHostWindow: class {}, ElectronService: class {} }))
vi.mock('./receiver.service', () => ({ ReceiverService: class {} }))
afterEach(() => vi.restoreAllMocks())

function fixture() {
    const real: Partial<PushSettings> = {}
    const settings = {} as typeof defaults
    // Tabby ConfigProxy exposes structural sections through a getter only,
    // and persists writes through setters on the section's individual leaves.
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
        Object.defineProperty(settings, key, {
            enumerable: true,
            get: () => real[key] ?? defaults[key],
            set: (value: unknown) => {
                Object.assign(real, { [key]: value })
            },
        })
    }
    const store = Object.defineProperty({}, 'pushToolkit', {
        enumerable: true,
        get: () => settings,
    }) as { readonly pushToolkit: PushSettings }
    let persisted: PushSettings | undefined
    const save = vi.fn(async () => {
        persisted = JSON.parse(JSON.stringify(settings)) as PushSettings
    })
    const receivers = { prefetch: vi.fn<ReceiverService['prefetch']>(async () => undefined) }
    const platform = { getConfigPath: () => '/tmp/tabby-custom/config.yaml', openPath: vi.fn() }
    const component = new PushSettingsComponent(
        { store, save } as unknown as ConfigService,
        {} as ElectronService,
        {} as ElectronHostWindow,
        platform as unknown as PlatformService,
        receivers as unknown as ReceiverService,
    )
    return {
        component,
        store,
        settings,
        real,
        save,
        platform,
        receivers,
        persisted: () => persisted,
    }
}

describe('settings persistence with Tabby ConfigProxy', () => {
    it.each(['.', './'])(
        'saves the current shell directory %j for uploads',
        async (remoteDirectory) => {
            const f = fixture()
            f.component.addFile()
            Object.assign(f.component.draft.files[0], { localPath: '/local/tool', remoteDirectory })
            await f.component.save()
            expect(f.component.error).toBe('')
            expect(f.component.saved).toBe(true)
            expect(f.persisted()?.files[0].remoteDirectory).toBe(remoteDirectory)
        },
    )

    it.each(['~/.local/bin', '', '/usr/local/bin', '~/my tools', '~/tools/trz'])(
        'saves remote tool directory %j without local bootstrap files',
        async (receiverDirectory) => {
            const f = fixture()
            f.component.draft.receiverDirectory = receiverDirectory
            await f.component.save()
            expect(f.component.error).toBe('')
            expect(f.component.saved).toBe(true)
            expect(f.persisted()?.receiverDirectory).toBe(receiverDirectory)
        },
    )

    it('saves through leaf setters without replacing the getter-only section', async () => {
        const f = fixture()
        f.component.addFile()
        Object.assign(f.component.draft.files[0], { name: 'Tool', localPath: '/local/tool' })
        f.component.draft.receiverDirectory = '~/bin'
        f.component.draft.chunkDelayMs = 20
        f.component.draft.timeoutMs = 90000

        await f.component.save()

        expect(f.component.error).toBe('')
        expect(f.component.saved).toBe(true)
        expect(f.save).toHaveBeenCalledOnce()
        expect(f.store.pushToolkit).toBe(f.settings)
        expect(f.real).toEqual(f.component.draft)
        expect(f.persisted()).toEqual(f.component.draft)
        expect(Object.getOwnPropertyDescriptor(f.store, 'pushToolkit')?.set).toBeUndefined()

        // Unsaved edits must remain isolated from the live configuration.
        f.component.draft.files[0].name = 'Unsaved edit'
        expect(f.settings.files[0].name).toBe('Tool')
        expect(f.component.receiverVersion).toBe('v1.3.0')
        expect(f.component.receiverCachePath).toBe(
            '/tmp/tabby-custom/push-toolkit/receivers/v1.3.0',
        )
    })

    it('leaves live settings unchanged when validation fails', async () => {
        const f = fixture()
        f.component.draft.timeoutMs = 0
        await f.component.save()
        expect(f.component.error).toContain('超时')
        expect(f.component.saved).toBe(false)
        expect(f.real).toEqual({})
        expect(f.save).not.toHaveBeenCalled()
    })

    it('rejects a relative tool directory before saving', async () => {
        const f = fixture()
        f.component.draft.receiverDirectory = 'bin'
        await f.component.save()
        expect(f.component.error).toContain('远端路径')
        expect(f.save).not.toHaveBeenCalled()
    })

    it('reports persistence errors and keeps the draft available for retry', async () => {
        const f = fixture()
        f.save.mockRejectedValueOnce(new Error('Cannot write config'))
        f.component.draft.receiverDirectory = '~/bin'
        await f.component.save()
        expect(f.component.error).toBe('Cannot write config')
        expect(f.component.saved).toBe(false)
        expect(f.component.draft.receiverDirectory).toBe('~/bin')
    })
})

describe('receiver buffer size settings', () => {
    it('defaults to 10K for existing configurations', () => {
        const f = fixture()
        expect(f.component.draft.receiverBufferSize).toBe('10K')
        expect(f.real).toEqual({})
    })

    it.each(['1K', '10K', '64K', '1M', '1G', '1024', '1073741824', ' 64k '])(
        'persists a valid buffer size %j',
        async (receiverBufferSize) => {
            const f = fixture()
            f.component.draft.receiverBufferSize = receiverBufferSize
            await f.component.save()
            expect(f.component.error).toBe('')
            expect(f.component.saved).toBe(true)
            expect(f.persisted()?.receiverBufferSize).toBe(receiverBufferSize)
        },
    )

    it.each([
        '',
        ' ',
        '0',
        '1023',
        '1073741825',
        '2G',
        '-1K',
        '1.5M',
        'NaN',
        '10K; echo bad',
        '10K\nGO',
    ])(
        'rejects an invalid buffer size %j without changing live settings',
        async (receiverBufferSize) => {
            const f = fixture()
            f.component.draft.receiverBufferSize = receiverBufferSize
            await f.component.save()
            expect(f.component.error).toContain('缓冲区大小')
            expect(f.component.saved).toBe(false)
            expect(f.real).toEqual({})
            expect(f.save).not.toHaveBeenCalled()
        },
    )
})

describe('receiver download settings', () => {
    it('saves custom sources and uses the selected source before the built-in backups', async () => {
        const f = fixture()
        f.component.addDownloadSource()
        const source = f.component.draft.receiverCustomSources[0]
        source.name = '内网镜像'
        source.url = 'https://mirror.example.com/trzsz-v1.3.0-all-platform.tar.gz'
        await f.component.save()
        expect(f.component.error).toBe('')
        expect(f.persisted()?.receiverDownloadSource).toBe(source.id)
        expect(receiverDownloadURLs(f.component.draft)).toEqual([
            source.url,
            ...RECEIVER_SOURCES.map((builtin) => builtin.url),
        ])
        source.url = 'https://unsaved.example.com/file'
        expect(f.settings.receiverCustomSources[0].url).toContain('mirror.example.com')
        f.component.removeDownloadSource(0)
        expect(f.component.draft.receiverDownloadSource).toBe('github')
    })

    it('uses Gitee first when selected and rejects invalid sources', () => {
        expect(receiverDownloadURLs({ ...defaults, receiverDownloadSource: 'gitee' })).toEqual([
            RECEIVER_SOURCES[1].url,
            RECEIVER_SOURCES[0].url,
        ])
        expect(() =>
            receiverDownloadURLs({ ...defaults, receiverDownloadSource: 'missing' }),
        ).toThrow('请选择')
        for (const url of ['', 'relative/path', 'file:///tmp/archive', 'javascript:alert(1)']) {
            expect(() =>
                receiverDownloadURLs({
                    receiverDownloadSource: 'custom',
                    receiverCustomSources: [{ id: 'custom', name: '自定义源', url }],
                }),
            ).toThrow()
        }
    })

    it('opens the cache directory after creating it if necessary', async () => {
        const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined)
        const f = fixture()
        await f.component.openCacheDirectory()
        expect(mkdir).toHaveBeenCalledWith(f.component.receiverCachePath, { recursive: true })
        expect(f.platform.openPath).toHaveBeenCalledWith(f.component.receiverCachePath)
    })

    it('reports a cache directory failure without opening it', async () => {
        vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('Permission denied'))
        const f = fixture()
        await f.component.openCacheDirectory()
        expect(f.component.error).toBe('Permission denied')
        expect(f.platform.openPath).not.toHaveBeenCalled()
    })

    it('prefetches using the draft selection without saving unrelated edits or requiring SSH', async () => {
        const f = fixture()
        f.component.draft.receiverDownloadSource = 'gitee'
        f.component.addFile()
        await f.component.predownload()
        expect(f.receivers.prefetch).toHaveBeenCalledWith(
            f.component.draft,
            expect.any(AbortSignal),
            expect.any(Function),
        )
        expect(f.component.downloadStatus).toContain('已缓存')
        expect(f.component.downloading).toBe(false)
        expect(f.component.downloadError).toBe('')
        expect(f.save).not.toHaveBeenCalled()
        expect(f.settings.receiverDownloadSource).toBe('github')
    })

    it('shows failures and supports cancellation without duplicate requests', async () => {
        const f = fixture()
        f.receivers.prefetch.mockImplementation(
            async (_settings, signal, status) =>
                new Promise((_resolve, reject) => {
                    status('正在下载…')
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                }),
        )
        const pending = f.component.predownload()
        expect(f.component.downloading).toBe(true)
        expect(f.component.downloadStatus).toBe('正在下载…')
        await f.component.predownload()
        expect(f.receivers.prefetch).toHaveBeenCalledOnce()
        f.component.cancelPredownload()
        await pending
        expect(f.component.downloadError).toContain('取消')
        expect(f.component.downloading).toBe(false)

        f.receivers.prefetch.mockRejectedValueOnce(new Error('All sources unavailable'))
        await f.component.predownload()
        expect(f.component.downloadError).toBe('All sources unavailable')
    })
})
