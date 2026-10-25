import { EventEmitter } from 'events'
import { Download, cancellationError } from './receiver-cache'

export interface DownloadRequest extends EventEmitter {
    end(): void
    abort(): void
    setHeader(name: string, value: string): void
}

interface DownloadResponse extends EventEmitter {
    statusCode: number
}

export interface ElectronNet {
    request(options: { method: 'GET'; url: string; redirect: 'follow' }): DownloadRequest
}

/** Electron networking honors the same system/session proxy configuration as Tabby. */
export function electronDownloader(net: ElectronNet, timeoutMs = 60000): Download {
    return (url, signal, limit) =>
        new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(cancellationError(signal))
                return
            }
            const request = net.request({ method: 'GET', url, redirect: 'follow' })
            const chunks: Buffer[] = []
            let size = 0
            let settled = false
            const finish = (error?: Error): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                signal.removeEventListener('abort', abort)
                if (error) {
                    reject(error)
                    try {
                        request.abort()
                    } catch {
                        /* preserve the original download error */
                    }
                } else resolve(Buffer.concat(chunks))
            }
            const abort = (): void => finish(cancellationError(signal))
            let timer: ReturnType<typeof setTimeout>
            const refreshTimeout = (): void => {
                clearTimeout(timer)
                timer = setTimeout(
                    () => finish(new Error('下载接收端超时，请检查下载源连接或系统代理。')),
                    timeoutMs,
                )
            }
            refreshTimeout()
            signal.addEventListener('abort', abort, { once: true })
            request.on('error', (error: Error) => finish(error))
            request.on('abort', () => finish(new Error('接收端下载连接已中止。')))
            request.on('response', (response: DownloadResponse) => {
                if (settled) return
                refreshTimeout()
                response.on('error', (error: Error) => finish(error))
                if (response.statusCode !== 200) {
                    finish(new Error(`下载接收端失败：HTTP ${response.statusCode}（${url}）。`))
                    return
                }
                // Register terminal events before data: adding a data listener
                // starts the main-process stream immediately, while remote calls
                // arrive separately. A fast response can otherwise finish first.
                response.on('aborted', () => finish(new Error('接收端下载内容被截断。')))
                response.on('end', () => finish())
                response.on('data', (data: Buffer) => {
                    if (settled) return
                    refreshTimeout()
                    const chunk = Buffer.from(data)
                    size += chunk.length
                    if (size > limit) {
                        finish(new Error('接收端下载内容超过大小限制。'))
                        return
                    }
                    chunks.push(chunk)
                })
            })
            try {
                request.setHeader('User-Agent', 'tabby-push-toolkit')
                request.end()
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)))
            }
        })
}
