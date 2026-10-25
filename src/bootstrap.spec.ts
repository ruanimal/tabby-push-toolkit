import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { workerCommand } from './worker'
import { adler32, posixCksum } from './shell'

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

it('does not evaluate a worker whose script terminator was not received', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-incomplete-worker-'))
    roots.push(root)
    const command = workerCommand({
        token: 'a'.repeat(32),
        receiverDirectory: path.join(root, 'tools'),
        bootstrapOnly: true,
    })
    const boundary = command.indexOf('\n')
    const input = command.slice(boundary + 1).replace(/PT[a-f0-9]{32}\n$/, '')
    const result = spawnSync('/bin/sh', ['-c', command.slice(0, boundary)], {
        input,
        encoding: 'utf8',
        timeout: 5000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain(':SCRIPT_READY')
    expect(result.stdout).toContain(':STOPPED')
    expect(result.stdout).not.toContain(':PROBE:')
    expect(result.stdout).not.toContain(':ERROR:INPUT')
})

describe.each([false, true])('bootstrap file validation with native=%s', (native) => {
    it.each([false, true])('verifies the whole file with corrupted=%s', async (corrupted) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-bootstrap-check-'))
        roots.push(root)
        const bin = path.join(root, 'bin')
        await fs.mkdir(bin)
        const tools = ['sh', 'mkdir', 'rm', 'mv', 'ln', 'wc', 'chmod', 'uname']
        if (native) tools.push('base64', 'cksum', 'cat')
        for (const tool of tools) await fs.symlink(`/usr/bin/${tool}`, path.join(bin, tool))
        const receiverDirectory = path.join(root, 'tools')
        const command = workerCommand({
            token: 'a'.repeat(32),
            receiverDirectory,
            bootstrapOnly: true,
        })
        const data = Buffer.from('#!/bin/sh\nexit 0\n#' + 'x'.repeat(2000) + '\n')
        const [a, b] = adler32(data)
        const transmitted = Buffer.from(data)
        if (corrupted) transmitted[100] ^= 1
        const lines = [`BOOT:${data.length}:${a}:${b}:${posixCksum(data)}:1`]
        for (let offset = 0; offset < transmitted.length; offset += 768)
            lines.push(transmitted.subarray(offset, offset + 768).toString('base64'))
        lines.push('END', '')
        const boundary = command.indexOf('\n')
        const result = spawnSync('/bin/sh', ['-c', command.slice(0, boundary)], {
            env: { ...process.env, PATH: bin, HOME: root },
            input: command.slice(boundary + 1) + lines.join('\n'),
            encoding: 'utf8',
            timeout: 5000,
        })
        expect(result.error).toBeUndefined()
        expect(result.stdout).toContain(native ? ':BOOT:NATIVE' : ':BOOT:SHELL')
        if (corrupted) {
            expect(result.stdout).toContain(':ERROR:CHECKSUM')
            expect(result.stdout).not.toContain(':SENDER_READY')
        } else {
            expect(result.stdout).toContain(':SENDER_READY')
            expect(result.stdout).not.toContain(':ERROR:CHECKSUM')
        }
        await expect(fs.stat(path.join(receiverDirectory, 'trz'))).rejects.toThrow()
        expect(await fs.readdir(receiverDirectory)).toEqual([])
    })
})
