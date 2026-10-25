import { DEFAULT_BOOTSTRAP_PATH } from './models'

export function quote(value: string): string {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('路径不能包含控制字符。')
    return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Expand only ~/; all other dollar signs and metacharacters remain literal. */
export function remotePath(value: string): string {
    if (value === '~') return '"$HOME"'
    if (value.startsWith('~/')) return `"$HOME"/${quote(value.slice(2))}`
    if (!value.startsWith('/')) throw new Error('远端路径必须以 / 或 ~/ 开头。')
    return quote(value)
}

/** A receiver may be a PATH command or a remote path; never interpret shell arguments. */
export function receiverLocation(value: string): { command: string; bootstrapPath: string } {
    if (value.startsWith('/') || value.startsWith('~/')) {
        const location = remotePath(value)
        return { command: location, bootstrapPath: location }
    }
    if (value && !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(value)) {
        throw new Error('接收端可填写命令名（如 trz）、以 / 或 ~/ 开头的路径，或留空自动检测。')
    }
    return { command: quote(value || 'trz'), bootstrapPath: remotePath(DEFAULT_BOOTSTRAP_PATH) }
}

export function adler32(data: Uint8Array): [number, number] {
    let a = 1,
        b = 0
    for (const byte of data) {
        a = (a + byte) % 65521
        b = (b + a) % 65521
    }
    return [a, b]
}
