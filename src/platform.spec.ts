import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { workerCommand } from './worker'

const token = 'a'.repeat(32)
const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function probe(
    shell: string,
    options: {
        architecture?: string
        header?: number[]
        missingOd?: boolean
        failProc?: boolean
        failOd?: boolean
    } = {},
) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-platform-'))
    roots.push(root)
    const bin = path.join(root, 'bin')
    await fs.mkdir(bin)
    await fs.symlink(shell, path.join(bin, 'sh'))
    for (const tool of ['mkdir', 'rm', 'mv', 'ln', 'wc']) {
        await fs.symlink(`/usr/bin/${tool}`, path.join(bin, tool))
    }
    await fs.writeFile(
        path.join(bin, 'uname'),
        '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n" ;; -m) printf "%s\\n" "$PROBE_ARCH" ;; *) exit 1 ;; esac\n',
        { mode: 0o700 },
    )
    const elf = path.join(root, 'shell.elf')
    await fs.writeFile(elf, Buffer.from(options.header ?? [127, 69, 76, 70, 1, 1]))
    const log = path.join(root, 'od.log')
    if (!options.missingOd) {
        await fs.writeFile(
            path.join(bin, 'od'),
            `#!/bin/sh
[ "$1:$2:$3:$4:$5:$6" = '-A:n:-t:u1:-N:6' ] || exit 1
shift 6
printf '%s\\n' "$1" >> "$OD_LOG"
[ "$FAIL_OD" != 1 ] || exit 1
case "$1" in
    /proc/*/exe) [ "$FAIL_PROC" != 1 ] || exit 1 ;;
    /bin/sh) ;;
    *) [ "$1" = "$EXPECTED_SH" ] || exit 1 ;;
esac
exec /usr/bin/od -A n -t u1 -N 6 "$PROBE_ELF"
`,
            { mode: 0o700 },
        )
    }
    // BusyBox ash may prefer built-in applets over PATH executables; functions override both.
    const overrides = [
        'uname() { "$TEST_BIN/uname" "$@"; }',
        ...(options.missingOd ? [] : ['od() { "$TEST_BIN/od" "$@"; }']),
    ].join('\n')
    const command = workerCommand({
        token,
        receiverDirectory: path.join(root, 'tools'),
        bootstrapOnly: true,
    }).replace('LC_ALL=C', `${overrides}\nLC_ALL=C`)
    const boundary = command.indexOf('\n')
    const result = spawnSync(path.join(bin, 'sh'), ['-c', command.slice(0, boundary)], {
        cwd: root,
        input: command.slice(boundary + 1),
        encoding: 'utf8',
        timeout: 5000,
        env: {
            ...process.env,
            PATH: bin,
            HOME: root,
            PROBE_ARCH: options.architecture ?? 'mips',
            PROBE_ELF: elf,
            TEST_BIN: bin,
            OD_LOG: log,
            EXPECTED_SH: path.join(bin, 'sh'),
            FAIL_PROC: options.failProc ? '1' : '0',
            FAIL_OD: options.failOd ? '1' : '0',
        },
    })
    if (result.error) throw result.error
    expect(result.signal).toBeNull()
    const calls = await fs.readFile(log, 'utf8').catch(() => '')
    return { output: result.stdout, calls: calls.trim().split('\n').filter(Boolean), bin }
}

describe.each(['/bin/sh', '/usr/bin/busybox'])('remote platform probe using %s', (shell) => {
    it.each([
        ['mips', 1, 'mipsel'],
        ['mips', 2, 'mips'],
        ['mipsel', 2, 'mips'],
    ])(
        'resolves uname %s and ELF byte order %s as %s',
        async (architecture, byteOrder, expected) => {
            const result = await probe(shell, {
                architecture: String(architecture),
                header: [127, 69, 76, 70, 1, Number(byteOrder)],
            })
            expect(result.output).toContain(`\x1ePT${token}:PROBE:Linux:${expected}:0:0\x1f`)
            expect(result.calls).toHaveLength(1)
        },
    )

    it('falls back to a shell executable when procfs is unavailable', async () => {
        const result = await probe(shell, { failProc: true })
        expect(result.output).toContain(`\x1ePT${token}:PROBE:Linux:mipsel:0:0\x1f`)
        expect(result.calls).toHaveLength(2)
        expect([path.join(result.bin, 'sh'), '/bin/sh']).toContain(result.calls[1])
    })

    it.each([
        [127, 69, 76, 70, 1, 0],
        [127, 69, 76, 70, 2, 1],
        [35, 33, 47, 98, 105, 110],
        [127, 69],
    ])('rejects an unknown or invalid ELF header %j', async (...header) => {
        const result = await probe(shell, { header })
        expect(result.output).toContain(`\x1ePT${token}:ERROR:ENDIANNESS\x1f`)
        expect(result.output).not.toContain(':PROBE:')
    })

    it('fails explicitly when no shell header can be read', async () => {
        const result = await probe(shell, { failOd: true })
        expect(result.output).toContain(`\x1ePT${token}:ERROR:ENDIANNESS\x1f`)
        expect(result.calls.length).toBeGreaterThanOrEqual(2)
        expect(result.calls.at(-1)).toBe('/bin/sh')
    })

    it('does not require od when bootstrapping another architecture', async () => {
        const result = await probe(shell, { architecture: 'x86_64', missingOd: true })
        expect(result.output).toContain(`\x1ePT${token}:PROBE:Linux:x86_64:0:0\x1f`)
        expect(result.calls).toEqual([])
    })
})

it('reports a missing od instead of guessing MIPS byte order', async () => {
    const result = await probe('/bin/sh', { missingOd: true })
    expect(result.output).toContain(`\x1ePT${token}:ERROR:MISSING_od\x1f`)
    expect(result.output).not.toContain(':PROBE:')
})
