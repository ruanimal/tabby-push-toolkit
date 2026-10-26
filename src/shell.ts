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

/** Upload destinations can also refer to the active remote shell's working directory. */
export function remoteUploadDirectory(value: string): string {
    if (value === '.' || value === './') return quote('.')
    return remotePath(value)
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

const cksumTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value << 24
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)
    return crc >>> 0
})

/** POSIX cksum CRC, including the file length (different from zlib CRC-32). */
export function posixCksum(data: Uint8Array): number {
    let crc = 0
    const update = (byte: number) => {
        crc = (crc << 8) ^ cksumTable[((crc >>> 24) ^ byte) & 0xff]
    }
    for (const byte of data) update(byte)
    for (let length = data.length; length > 0; length = Math.floor(length / 256))
        update(length & 0xff)
    return ~crc >>> 0
}
