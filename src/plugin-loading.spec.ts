import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

describe('shared trzsz plugin ownership', () => {
    it('loads without activating a private trzsz module', () => {
        let metadata: { imports: unknown[] } | undefined
        const common = class {}
        const forms = class {}
        const core = class {}
        const stubs: Record<string, unknown> = {
            '@angular/core': {
                NgModule: (options: typeof metadata) => (target: unknown) => {
                    metadata = options
                    return target
                },
            },
            '@angular/common': { CommonModule: common },
            '@angular/forms': { FormsModule: forms },
            'tabby-core': {
                __esModule: true,
                default: core,
                ConfigProvider: class {},
                TabContextMenuItemProvider: class {},
            },
            'tabby-settings': { SettingsTabProvider: class {} },
            './config': { PushConfigProvider: class {} },
            './menu': { PushContextMenuProvider: class {} },
            './settings': { PushSettingsTabProvider: class {} },
            './settings.component': { PushSettingsComponent: class {} },
        }
        const require = vi.fn((name: string) => {
            if (!(name in stubs)) throw new Error(`Unexpected plugin import: ${name}`)
            return stubs[name]
        })
        const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
        const compiled = transpileModule(source, {
            compilerOptions: {
                module: ModuleKind.CommonJS,
                target: ScriptTarget.ES2020,
                experimentalDecorators: true,
            },
        }).outputText
        const exports: Record<string, unknown> = {}
        runInNewContext(compiled, { exports, require })
        expect(typeof exports.default).toBe('function')
        expect(metadata?.imports).toEqual([common, forms, core])
        expect(require).not.toHaveBeenCalledWith('tabby-trzsz')

        const manifest = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        )
        expect(manifest.dependencies['tabby-trzsz']).toBeUndefined()
        expect(manifest.peerDependencies['tabby-trzsz']).toBe('^1.0.7')
    })
})
