import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { quote, remotePath, receiverLocation, adler32 } from './shell'
import {
    defaults,
    DEFAULT_BOOTSTRAP_PATH,
    selectReceiver,
    validateName,
    validateSettings,
} from './models'

describe('shell paths and receiver selection', () => {
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

    it('uses the remote architecture and rejects missing or ambiguous matches', () => {
        const receivers = [
            { id: 'a', platform: 'Linux', architecture: 'amd64', localPath: '/trz', note: '' },
        ]
        expect(selectReceiver(receivers, 'Linux', 'x86_64')).toBe(receivers[0])
        expect(() => selectReceiver(receivers, 'Linux', 'aarch64')).toThrow()
        expect(() => selectReceiver([...receivers, ...receivers], 'Linux', 'x86_64')).toThrow()
        expect(() => validateSettings({ ...defaults, chunkDelayMs: NaN })).toThrow()
        expect(() => validateSettings({ ...defaults, timeoutMs: 0 })).toThrow()
    })

    it('accepts installed command names, explicit paths and automatic detection', () => {
        expect(receiverLocation('trz')).toEqual({
            command: quote('trz'),
            bootstrapPath: remotePath(DEFAULT_BOOTSTRAP_PATH),
        })
        expect(receiverLocation('')).toEqual(receiverLocation('trz'))
        for (const location of ['/opt/trz tools/trz', '~/bin/trz']) {
            expect(receiverLocation(location)).toEqual({
                command: remotePath(location),
                bootstrapPath: remotePath(location),
            })
        }
        for (const command of [
            'trz; echo injected',
            'trz --flag',
            '$(trz)',
            'relative/trz',
            'trz\n',
        ]) {
            expect(() => receiverLocation(command)).toThrow()
        }
    })
})

const decoder = readFileSync(new URL('../scripts/base64-decode.sh', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../scripts/bootstrap-decoder.sh', import.meta.url), 'utf8')
const shells = [['sh'], ['/usr/bin/busybox', 'ash']]

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
})
