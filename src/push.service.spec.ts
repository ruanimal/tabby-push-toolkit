import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, Stats } from 'fs'
import { Subject } from 'rxjs'
import type { ConfigService, HotkeysService, NotificationsService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import type { OperationOptions } from './operation'
import type { ReceiverService } from './receiver.service'
import { defaults, SavedFile } from './models'
import { PushService, PushTerminal } from './push.service'

const clock = vi.hoisted(() => ({ now: 0 }))
const runner = vi.hoisted(() => ({ run: vi.fn<(options: OperationOptions) => Promise<void>>() }))
vi.mock('perf_hooks', () => ({ performance: { now: () => clock.now } }))
vi.mock('@angular/core', () => ({ Injectable: () => (target: unknown) => target }))
vi.mock('tabby-core', () => ({
    ConfigService: class {},
    HotkeysService: class {},
    NotificationsService: class {},
}))
vi.mock('tabby-terminal', () => ({ BaseTerminalTabComponent: class {} }))
vi.mock('./receiver.service', () => ({ ReceiverService: class {} }))
vi.mock('./middleware', () => {
    class Middleware {
        close() {
            // No live middleware subscriptions in this fixture.
        }
    }
    return { PushMiddleware: Middleware, PushInputLock: Middleware }
})
vi.mock('./operation', () => ({
    PushOperation: class {
        constructor(private options: OperationOptions) {}
        run() {
            return runner.run(this.options)
        }
    },
}))
afterEach(() => {
    vi.restoreAllMocks()
    runner.run.mockReset()
})

function fixture() {
    clock.now = 1000
    const tab = Object.assign(Object.create(BaseTerminalTabComponent.prototype), {
        session: {
            open: true,
            closed$: new Subject(),
            middleware: { unshift: vi.fn(), push: vi.fn(), remove: vi.fn() },
        },
        sessionChanged$: new Subject(),
        trzsz: { isTransferringFiles: () => false },
        write: vi.fn(),
    }) as unknown as PushTerminal
    const notifications = { info: vi.fn(), error: vi.fn() }
    const service = new PushService(
        { store: { pushToolkit: defaults } } as unknown as ConfigService,
        notifications as unknown as NotificationsService,
        { hotkey$: new Subject() } as unknown as HotkeysService,
        {} as ReceiverService,
    )
    return { tab, notifications, service }
}

describe('menu operation timing', () => {
    it('times each bootstrap separately and freezes the duration before local cleanup', async () => {
        const f = fixture()
        for (const durationMs of [12340, 250]) {
            runner.run.mockImplementation(async (options) => {
                clock.now += durationMs
                options.onStopped?.()
                clock.now += 5000
            })
            await f.service.bootstrap(f.tab)
            const duration = `${(durationMs / 1000).toFixed(2)} 秒`
            expect(f.tab.write).toHaveBeenLastCalledWith(
                `\r\n[Push Toolkit] 引导传输端耗时：${duration}。\r\n`,
            )
            expect(f.notifications.info).toHaveBeenLastCalledWith(
                'Push Toolkit：传输端已就绪',
                `${defaults.receiverDirectory}\n耗时：${duration}`,
            )
        }
    })

    it('includes file preparation and identifies the selected menu item', async () => {
        const f = fixture()
        vi.spyOn(fs, 'stat').mockImplementation(async () => {
            clock.now += 1000
            return { isFile: () => true, size: 10 } as Stats
        })
        vi.spyOn(fs, 'mkdtemp').mockResolvedValue('/tmp/push-timing-test')
        vi.spyOn(fs, 'copyFile').mockResolvedValue(undefined)
        vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
        runner.run.mockImplementation(async (options) => {
            clock.now += 500
            options.onStopped?.()
        })
        await f.service.push(f.tab, {
            name: '诊断工具',
            localPath: '/local/tool',
            remoteDirectory: '/remote',
            remoteName: 'tool',
        } as SavedFile)
        expect(f.tab.write).toHaveBeenLastCalledWith(
            '\r\n[Push Toolkit] 诊断工具耗时：2.50 秒。\r\n',
        )
        expect(f.notifications.info).toHaveBeenCalledWith(
            'Push Toolkit：上传完成',
            '/remote/tool\n耗时：2.50 秒',
        )
    })

    it.each(['传输失败', '已取消当前操作。'])(
        'also reports timing when the operation ends with %s',
        async (message) => {
            const f = fixture()
            runner.run.mockImplementation(async (options) => {
                clock.now += 1250
                options.onStopped?.()
                throw new Error(message)
            })
            await f.service.bootstrap(f.tab)
            expect(f.tab.write).toHaveBeenLastCalledWith(
                '\r\n[Push Toolkit] 引导传输端耗时：1.25 秒。\r\n',
            )
            expect(f.notifications.error).toHaveBeenCalledWith(
                'Push Toolkit：引导失败',
                `${message}\n耗时：1.25 秒`,
            )
            expect(f.notifications.info).not.toHaveBeenCalled()
        },
    )
})
