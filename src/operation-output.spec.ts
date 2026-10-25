import { describe, expect, it, vi } from 'vitest'
import { PushOperation } from './operation'
import { defaults } from './models'

const token = 'a'.repeat(32)
const frame = (message: string) => `\x1ePT${token}:${message}\x1f`

function fixture(status: (message: string) => void = () => undefined, onStopped?: () => void) {
    return new PushOperation(
        {
            token,
            receiverDirectory: '~/bin',
            bootstrapOnly: true,
            settings: defaults,
            loadReceiver: async () => ({ trz: Buffer.alloc(0), tsz: Buffer.alloc(0) }),
            status,
            onStopped,
        },
        {
            uploadFiles: async () => undefined,
            stopTransferringFiles: () => undefined,
            isTransferringFiles: () => false,
        },
        () => undefined,
    )
}

describe('shell output handoff', () => {
    it.each(['DONE', 'BOOTSTRAP_DONE'])(
        'preserves a prompt coalesced with %s and STOPPED at every split point',
        (completion) => {
            const prompt = '\r\n\x1b[32m/app #\x1b[0m '
            const wire = Buffer.from(
                `private worker output${frame(completion)}\r\nhidden cleanup output${frame('STOPPED')}${prompt}`,
            )
            for (let split = 0; split <= wire.length; split++) {
                const visible: string[] = []
                const operation = fixture((message) => visible.push(message))
                for (const part of [wire.subarray(0, split), wire.subarray(split)]) {
                    const output = operation.feedFromSession(part)
                    if (output.length) visible.push(output.toString())
                }
                expect(visible.join('')).toBe(
                    (completion === 'DONE' ? '上传完成。' : 'trz 和 tsz 已就绪。') + prompt,
                )
                expect(operation.feedFromSession(Buffer.from('later output')).toString()).toBe(
                    'later output',
                )
            }
        },
    )

    it('preserves the prompt after an error without displaying a late success message', () => {
        const status = vi.fn()
        const operation = fixture(status)
        expect(
            operation
                .feedFromSession(
                    Buffer.from(
                        `${frame('ERROR:EXISTS')}${frame('DONE')}${frame('STOPPED')}\r\n/app # `,
                    ),
                )
                .toString(),
        ).toBe('\r\n/app # ')
        expect(status).not.toHaveBeenCalled()
    })

    it.each(['DONE', 'BOOTSTRAP_DONE', 'ERROR:EXISTS'])(
        'reports timing before the prompt after %s, exactly once',
        (completion) => {
            const visible: string[] = []
            const onStopped = vi.fn(() => visible.push('耗时：12.34 秒\r\n'))
            const operation = fixture(() => undefined, onStopped)
            visible.push(
                operation
                    .feedFromSession(Buffer.from(`${frame(completion)}${frame('STOPPED')}/app # `))
                    .toString(),
            )
            expect(visible.join('')).toBe('耗时：12.34 秒\r\n/app # ')
            operation.feedFromSession(Buffer.from(frame('STOPPED')))
            expect(onStopped).toHaveBeenCalledOnce()
        },
    )
})
