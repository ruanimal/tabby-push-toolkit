import { describe, expect, it, vi } from 'vitest'
import { PushInputLock } from './middleware'

vi.mock('tabby-terminal', async () => {
    const { Subject } = await import('rxjs')
    return {
        SessionMiddleware: class {
            outputToSession$ = new Subject<Buffer>()
            outputToTerminal$ = new Subject<Buffer>()
            feedFromSession(data: Buffer): void {
                this.outputToTerminal$.next(data)
            }
            feedFromTerminal(data: Buffer): void {
                this.outputToSession$.next(data)
            }
        },
    }
})

describe('terminal input lock', () => {
    it('blocks typing, paste and mouse input before a handshake while preserving output and cancellation', () => {
        const cancel = vi.fn()
        const lock = new PushInputLock(cancel)
        const sent: Buffer[] = []
        const displayed: Buffer[] = []
        lock.outputToSession$.subscribe((data) => sent.push(data))
        lock.outputToTerminal$.subscribe((data) => displayed.push(data))
        for (const input of ['typed command\r', 'trz\r', '\x1b[<0;1;1M', '\x03'])
            lock.feedFromTerminal(Buffer.from(input))
        lock.feedFromSession(Buffer.from('remote output'))
        expect(sent).toEqual([])
        expect(cancel).toHaveBeenCalledOnce()
        expect(Buffer.concat(displayed).toString()).toBe('remote output')
    })
})
