import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { DownloadRequest, electronDownloader } from './download'

function fixture(timeoutMs = 1000) {
    const request = Object.assign(new EventEmitter(), {
        end: vi.fn(),
        abort: vi.fn(),
        setHeader: vi.fn(),
    }) satisfies DownloadRequest
    const net = { request: vi.fn(() => request) }
    const response = Object.assign(new EventEmitter(), { statusCode: 200 })
    return { request, net, response, download: electronDownloader(net, timeoutMs) }
}

describe('Electron receiver downloads', () => {
    it('uses Chromium networking and follows release redirects', async () => {
        const f = fixture()
        const pending = f.download('https://github.com/release', new AbortController().signal, 100)
        f.request.emit('response', f.response)
        f.response.emit('data', Buffer.from('hello'))
        f.response.emit('data', Buffer.from(' world'))
        f.response.emit('end')
        expect(await pending).toEqual(Buffer.from('hello world'))
        expect(f.net.request).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://github.com/release',
            redirect: 'follow',
        })
    })

    it('completes a fast HTTP response that ends as soon as the data listener is attached', async () => {
        const f = fixture(20)
        const pending = f.download(
            'http://192.168.10.20:8000/trzsz-v1.3.0-all-platform.tar.gz',
            new AbortController().signal,
            100,
        )
        const data = Buffer.from('fast LAN response')
        const on = f.response.on.bind(f.response)
        vi.spyOn(f.response, 'on').mockImplementation((event, listener) => {
            on(event, listener)
            if (event === 'data') {
                // A main-process stream can drain before the next remote .on() call.
                f.response.emit('data', data)
                f.response.emit('end')
            }
            return f.response
        })
        f.request.emit('response', f.response)
        expect(await pending).toEqual(data)
        expect(f.request.abort).not.toHaveBeenCalled()
    })

    it('rejects a fast response aborted immediately after its first chunk', async () => {
        const f = fixture(20)
        const pending = f.download(
            'http://192.168.10.20:8000/file',
            new AbortController().signal,
            100,
        )
        const on = f.response.on.bind(f.response)
        vi.spyOn(f.response, 'on').mockImplementation((event, listener) => {
            on(event, listener)
            if (event === 'data') {
                f.response.emit('data', Buffer.from('partial'))
                f.response.emit('aborted')
            }
            return f.response
        })
        f.request.emit('response', f.response)
        await expect(pending).rejects.toThrow('截断')
        expect(f.request.abort).toHaveBeenCalledOnce()
    })

    it('rejects HTTP errors and oversized responses', async () => {
        for (const failure of ['HTTP 404', '大小限制']) {
            const f = fixture()
            const pending = f.download(
                'https://github.com/release',
                new AbortController().signal,
                2,
            )
            if (failure === 'HTTP 404') f.response.statusCode = 404
            f.request.emit('response', f.response)
            f.response.emit('data', Buffer.from('too large'))
            await expect(pending).rejects.toThrow(failure)
            expect(f.request.abort).toHaveBeenCalledOnce()
        }
    })

    it('stops on cancellation and timeout', async () => {
        const f = fixture()
        const controller = new AbortController()
        const pending = f.download('https://github.com/release', controller.signal, 100)
        controller.abort(new Error('Cancelled'))
        await expect(pending).rejects.toThrow('Cancelled')
        expect(f.request.abort).toHaveBeenCalledOnce()
        const stalled = fixture(5)
        await expect(
            stalled.download('https://github.com/release', new AbortController().signal, 100),
        ).rejects.toThrow('超时')
        expect(stalled.request.abort).toHaveBeenCalledOnce()
    })

    it('keeps a slow full-platform download alive while data continues arriving', async () => {
        vi.useFakeTimers()
        try {
            const f = fixture(1000)
            const pending = f.download(
                'https://github.com/release',
                new AbortController().signal,
                100,
            )
            f.request.emit('response', f.response)
            for (let i = 0; i < 3; i++) {
                await vi.advanceTimersByTimeAsync(900)
                f.response.emit('data', Buffer.from('a'))
            }
            f.response.emit('end')
            expect(await pending).toEqual(Buffer.from('aaa'))
            expect(f.request.abort).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
