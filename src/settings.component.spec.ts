import { describe, expect, it, vi } from 'vitest'
import type { ConfigService } from 'tabby-core'
import type { ElectronHostWindow, ElectronService } from 'tabby-electron'
import { defaults, PushSettings } from './models'
import { PushSettingsComponent } from './settings.component'

vi.mock('@angular/core', () => ({ Component: () => (target: unknown) => target }))
vi.mock('tabby-core', () => ({ ConfigService: class {} }))
vi.mock('tabby-electron', () => ({ ElectronHostWindow: class {}, ElectronService: class {} }))

function fixture() {
    const real: Partial<PushSettings> = {}
    const settings = {} as PushSettings
    // Tabby ConfigProxy exposes structural sections through a getter only,
    // and persists writes through setters on the section's individual leaves.
    for (const key of Object.keys(defaults) as (keyof PushSettings)[]) {
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
    const component = new PushSettingsComponent(
        { store, save } as unknown as ConfigService,
        {} as ElectronService,
        {} as ElectronHostWindow,
    )
    return { component, store, settings, real, save, persisted: () => persisted }
}

describe('settings persistence with Tabby ConfigProxy', () => {
    it.each(['trz', '', '/usr/local/bin/trz', '~/bin/trz'])(
        'saves installed receiver setting %j without local bootstrap files',
        async (receiverPath) => {
            const f = fixture()
            f.component.draft.receiverPath = receiverPath
            // An unfinished optional bootstrap row must not prevent using installed trz.
            f.component.addReceiver()
            await f.component.save()
            expect(f.component.error).toBe('')
            expect(f.component.saved).toBe(true)
            expect(f.persisted()?.receiverPath).toBe(receiverPath)
        },
    )

    it('saves through leaf setters without replacing the getter-only section', async () => {
        const f = fixture()
        f.component.addFile()
        Object.assign(f.component.draft.files[0], { name: 'Tool', localPath: '/local/tool' })
        f.component.addReceiver()
        Object.assign(f.component.draft.receivers[0], {
            architecture: 'x86_64',
            localPath: '/local/trz',
        })
        f.component.draft.receiverPath = '~/bin/trz'
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
        f.component.draft.receivers[0].note = 'Unsaved note'
        expect(f.settings.files[0].name).toBe('Tool')
        expect(f.settings.receivers[0].note).toBe('')
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

    it('reports persistence errors and keeps the draft available for retry', async () => {
        const f = fixture()
        f.save.mockRejectedValueOnce(new Error('Cannot write config'))
        f.component.draft.receiverPath = '~/bin/trz'
        await f.component.save()
        expect(f.component.error).toBe('Cannot write config')
        expect(f.component.saved).toBe(false)
        expect(f.component.draft.receiverPath).toBe('~/bin/trz')
    })
})
