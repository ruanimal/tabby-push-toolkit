import { DEFAULT_RECEIVER_DIRECTORY } from './models'

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

/** Detection and bootstrap always use the same directory. */
export function receiverLocation(value: string): { directory: string; command: string } {
    const directory = (value || DEFAULT_RECEIVER_DIRECTORY).replace(/\/+$/, '') || '/'
    return {
        directory: remotePath(directory),
        command: remotePath(`${directory === '/' ? '' : directory}/trz`),
    }
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
