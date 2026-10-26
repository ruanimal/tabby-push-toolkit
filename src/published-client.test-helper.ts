// Exercise the published plugin's bundled engine and its terminal.trzsz contract.
// The small Tabby/Angular host stubs let it run without starting Electron.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'
import { Subject } from 'rxjs'
import { TransferClient } from './operation'

export async function publishedClient(
    send: (data: Buffer) => void,
    downloadDirectory?: string,
    display: (data: Buffer) => void = () => undefined,
): Promise<TransferClient & { processServerOutput(data: Buffer): void }> {
    const require = createRequire(import.meta.url)
    let metadata: any
    class SessionMiddleware {
        feedFromSession(data: Buffer): void {
            display(data)
        }
        feedFromTerminal(data: Buffer): void {
            send(data)
        }
    }
    class TerminalDecorator {
        subscribeUntilDetached(): void {
            /* no live host subscriptions */
        }
    }
    const stubs: Record<string, unknown> = {
        '@angular/core': {
            Injectable: () => (target: unknown) => target,
            Component: () => (target: unknown) => target,
            NgModule: (options: unknown) => (target: unknown) => {
                metadata = options
                return target
            },
        },
        '@angular/common': {},
        '@angular/forms': {},
        'tabby-core': {
            ConfigProvider: class {},
            ConfigService: class {},
            HotkeysService: class {},
        },
        'tabby-settings': { SettingsTabProvider: class {} },
        'tabby-terminal': { SessionMiddleware, TerminalDecorator },
        'tabby-electron': {},
    }
    const module = { exports: {} }
    runInNewContext(readFileSync(require.resolve('tabby-trzsz'), 'utf8'), {
        module,
        exports: module.exports,
        global: {},
        process,
        Buffer,
        console,
        setTimeout,
        clearTimeout,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        Float64Array,
        require: Object.assign((name: string) => stubs[name] ?? require(name), {
            resolve: require.resolve,
        }),
    })
    const Provider = metadata.providers.find(
        (provider: any) => provider.provide === TerminalDecorator,
    ).useClass
    let middleware: any
    const terminal: any = {
        profile: { type: 'ssh' },
        size: { columns: 80 },
        session: {
            middleware: {
                unshift(value: unknown) {
                    middleware = value
                },
            },
        },
        element: {
            nativeElement: {
                querySelector: () => ({
                    addEventListener() {
                        /* no DOM */
                    },
                }),
            },
        },
        resize$: new Subject(),
        sessionChanged$: new Subject(),
    }
    const decorator = new Provider(
        { store: { trzszPlugin: { defaultDownloadPath: downloadDirectory } } },
        { hotkey$: new Subject() },
        {},
        {},
    )
    decorator.attach(terminal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (!terminal.trzsz || terminal.trzsz !== middleware?.trzsz)
        throw new Error('Upstream terminal.trzsz contract changed')
    return terminal.trzsz
}
