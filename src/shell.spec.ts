import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import {
    quote,
    remotePath,
    remoteUploadDirectory,
    receiverLocation,
    adler32,
    posixCksum,
} from './shell'
import { defaults, validateName, validateSettings } from './models'

describe('shell paths and receiver selection', () => {
    it('accepts the current directory only for upload destinations', () => {
        for (const directory of ['.', './']) {
            expect(remoteUploadDirectory(directory)).toBe("'.'")
            expect(() => remotePath(directory)).toThrow()
            expect(() => receiverLocation(directory)).toThrow()
        }
        for (const directory of ['/tmp', '~/tools', '~', "/tmp/a ' $HOME"])
            expect(remoteUploadDirectory(directory)).toBe(remotePath(directory))
        for (const directory of ['', 'tools', './tools', '..', '$PWD', '.\n'])
            expect(() => remoteUploadDirectory(directory)).toThrow()
    })

    it('quotes metacharacters literally while expanding only a home prefix', () => {
        const path = `/tmp/a ' $(touch /tmp/should-not-exist) " ; #`
        const result = spawnSync('sh', ['-c', `printf '%s' ${quote(path)}`])
        expect(result.stdout.toString()).toBe(path)
        expect(
            spawnSync('sh', ['-c', `printf '%s' ${remotePath('~/a $USER')}`], {
                env: { HOME: '/home/test' },
            }).stdout.toString(),
        ).toBe('/home/test/a $USER')
        expect(() => remotePath('relative')).toThrow()
        expect(() => quote('bad\npath')).toThrow()
        for (const name of ['', '.', '..', '../tool', 'a\\b', 'x\r'])
            expect(() => validateName(name)).toThrow()
    })

    it('rejects invalid transfer timing settings', () => {
        expect(() => validateSettings({ ...defaults, chunkDelayMs: NaN })).toThrow()
        expect(() => validateSettings({ ...defaults, timeoutMs: 0 })).toThrow()
    })

    it('uses the configured directory for detection and installation', () => {
        expect(defaults.receiverDirectory).toBe('~/.local/bin')
        expect(receiverLocation('').command).toBe(remotePath('~/.local/bin/trz'))
        for (const location of ["/opt/trz tools ' $HOME", '~/bin', '~', '/bin/trz']) {
            expect(receiverLocation(location)).toEqual({
                directory: remotePath(location),
                command: remotePath(`${location}/trz`),
            })
        }
        expect(receiverLocation('/')).toEqual({
            directory: remotePath('/'),
            command: remotePath('/trz'),
        })
        expect(receiverLocation('~/')).toEqual(receiverLocation('~'))
        expect(receiverLocation('~/bin///')).toEqual(receiverLocation('~/bin'))
        for (const directory of ['trz', 'trz; echo injected', 'relative/dir', '~/bad\npath']) {
            expect(() => receiverLocation(directory)).toThrow()
        }
    })
})

const decoder = readFileSync(new URL('../scripts/base64-decode.sh', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../scripts/bootstrap-decoder.sh', import.meta.url), 'utf8')
const shells = [['sh'], ['/usr/bin/busybox', 'ash']]

describe('POSIX cksum interoperability', () => {
    it.each([0, 1, 2, 255, 256, 768, 551184])('matches native cksum for %i bytes', (length) => {
        const input = Buffer.from(Array.from({ length }, (_, i) => i & 0xff))
        const result = spawnSync('cksum', [], { input })
        expect(result.status).toBe(0)
        expect(result.stdout.toString().trim()).toBe(`${posixCksum(input)} ${length}`)
    })
})

describe.each(shells)('decoder under %s', (...command) => {
    function run(script: string, input: string) {
        return spawnSync(command[0], [...command.slice(1), '-c', script], { input })
    }

    it('restores empty, short, all-byte, CRLF and unterminated input', () => {
        for (const input of [
            Buffer.alloc(0),
            Buffer.from('x'),
            Buffer.from('hello'),
            Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
        ]) {
            const encoded =
                input
                    .toString('base64')
                    .match(/.{1,76}/g)
                    ?.join('\r\n') ?? ''
            const result = run(decoder, encoded)
            expect(result.status).toBe(0)
            expect(result.stdout).toEqual(input)
            const [a, b] = adler32(input)
            const single = run(
                `${bootstrap}\nsum_a=1 sum_b=0 total=0\ndecode_chunk ${quote(input.toString('base64'))}\nprintf '%s' "$total:$sum_a:$sum_b" >&2`,
                '',
            )
            expect(single.status).toBe(0)
            expect(single.stdout).toEqual(input)
            expect(single.stderr.toString()).toBe(`${input.length}:${a}:${b}`)
        }
    })

    it('rejects invalid alphabet, padding and nonzero trailing bits', () => {
        for (const input of [
            'A',
            'AAA',
            'A===',
            'AA=A',
            'AA==A',
            'AB==',
            'AAB=',
            '?AAA',
            'AAAA=',
            '====',
        ]) {
            expect(run(decoder, input).status, input).not.toBe(0)
            expect(
                run(`${bootstrap}\nsum_a=1 sum_b=0 total=0\ndecode_chunk ${quote(input)}`, '')
                    .status,
                input,
            ).not.toBe(0)
        }
    })

    it.each(['gnu', 'bsd', 'unusable', 'missing'])(
        'detects %s native tools and preserves binary chunks and checksums',
        (mode) => {
            const input = Buffer.from(Array.from({ length: 768 }, (_, i) => i & 0xff))
            const override = {
                gnu: 'base64() { /usr/bin/base64 "$@"; }',
                bsd: 'base64() { [ "$1" = -D ] || return 1; /usr/bin/base64 -d; }',
                unusable: 'base64() { cat >/dev/null; printf broken; }',
                missing: 'cksum() { return 127; }',
            }[mode]
            const native = mode === 'gnu' || mode === 'bsd'
            const [a, b] = adler32(input)
            const result = run(
                `${bootstrap}
boot_stage=$(mktemp -d)
trap 'rm -rf "$boot_stage"' 0
${override}
detect_native_decoder
sum_a=1 sum_b=0 total=0
if [ -n "$native_flag" ]; then
    decode_native_chunk ${quote(input.toString('base64'))} || exit 1
    printf '%s' "native:$total:$chunk_crc" >&2
else
    decode_chunk ${quote(input.toString('base64'))} || exit 1
    printf '%s' "shell:$total:$sum_a:$sum_b" >&2
fi`,
                '',
            )
            expect(result.status).toBe(0)
            expect(result.stdout).toEqual(input)
            expect(result.stderr.toString()).toBe(
                native ? `native:768:${posixCksum(input)}` : `shell:768:${a}:${b}`,
            )
        },
    )
})
