import { afterEach, describe, it, expect } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { randomBytes } from 'crypto'
import { TrzszFilter } from 'trzsz'
import { defaults, DEFAULT_RECEIVER_DIRECTORY } from './models'
import { quote } from './shell'
import { OperationOptions, PushOperation } from './operation'
import { publishedClient } from './published-client.test-helper'

const require = createRequire(import.meta.url)
const resources: { root: string; child: ChildProcessWithoutNullStreams }[] = []
afterEach(async () => {
    for (const { root, child } of resources.splice(0)) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
            if (child.exitCode !== null) resolve(undefined)
            else child.once('exit', resolve)
        })
        await fs.rm(root, { recursive: true, force: true })
    }
})

async function fixture(
    options: {
        published?: boolean
        receiver?: string
        shell?: string[]
        overwrite?: boolean
        data?: Buffer
        minimalPath?: boolean
        receiverDirectory?: string
    } = {},
) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "push-test ' -"))
    const bin = path.join(root, 'bin')
    await fs.mkdir(bin)
    const tools = ['sh', 'mkdir', 'rm', 'mv', 'ln', 'wc', 'chmod', 'stty']
    if (!options.minimalPath) tools.push('uname')
    for (const tool of tools) {
        await fs.symlink(`/usr/bin/${tool}`, path.join(bin, tool))
    }
    const child = spawn(
        '/usr/bin/python3',
        ['-u', path.resolve('tests/pty-server.py'), ...(options.shell ?? ['/bin/sh'])],
        {
            stdio: 'pipe',
            cwd: root,
            env: {
                ...process.env,
                HOME: root,
                PATH: bin,
            },
        },
    )
    resources.push({ root, child })
    const data = options.data ?? randomBytes(100001)
    const filename = "tool ' $HOME.bin"
    const local = path.join(root, filename)
    await fs.writeFile(local, data)
    const destination = path.join(root, "remote ' dir")
    const receiverDirectory = options.receiverDirectory ?? DEFAULT_RECEIVER_DIRECTORY
    const directory = receiverDirectory.startsWith('~/')
        ? path.join(root, receiverDirectory.slice(2))
        : receiverDirectory
    const receiverPath = path.join(directory, 'trz')
    const receiver = options.receiver
        ? await fs.readFile(options.receiver)
        : Buffer.from(
              `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(require.resolve('trzsz/bin/trz.js'))} "$@"\n`,
          )
    const sender = Buffer.from(
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(require.resolve('trzsz/bin/tsz.js'))} "$@"\n`,
    )
    const downloads = path.join(root, 'downloads')
    await fs.mkdir(downloads)
    let managed = true
    const send = (buffer: Buffer): void => {
        if (managed) operation.feedFromTerminal(buffer)
        else child.stdin.write(buffer)
    }
    const client = options.published
        ? await publishedClient(send, downloads)
        : new TrzszFilter({
              sendToServer: (data) => send(Buffer.from(data)),
              writeToTerminal: () => undefined,
              chooseSendFiles: async () => {
                  throw new Error('Unexpected picker')
              },
              chooseSaveDirectory: async () => downloads,
          })
    const statuses: string[] = []
    const operationOptions: OperationOptions = {
        token: randomBytes(16).toString('hex'),
        receiverDirectory,
        destination,
        filename,
        fileSize: data.length,
        executable: true,
        overwrite: options.overwrite ?? false,
        localPath: local,
        settings: {
            ...defaults,
            chunkDelayMs: 0,
            timeoutMs: 8000,
        },
        loadReceiver: async () => ({ trz: receiver, tsz: sender }),
        status: (status) => statuses.push(status),
    }
    const operation = new PushOperation(operationOptions, client, (buffer) => {
        child.stdin.write(buffer)
    })
    let transcript = ''
    child.stderr.on('data', (buffer) => {
        transcript += buffer.toString()
    })
    child.stdout.on('data', (buffer: Buffer) => {
        transcript += buffer.toString()
        if (!managed) {
            client.processServerOutput(buffer)
            return
        }
        // Force a handshake and every status frame to cross SSH output boundaries.
        for (let offset = 0; offset < buffer.length; offset += 7) {
            const output = operation.feedFromSession(buffer.subarray(offset, offset + 7))
            if (output.length) client.processServerOutput(output)
        }
    })
    return {
        root,
        bin,
        child,
        data,
        filename,
        destination,
        receiverPath,
        receiver,
        sender,
        statuses,
        client,
        downloads,
        enableManual: () => {
            managed = false
        },
        options: operationOptions,
        operation,
        transcript: () => transcript,
    }
}

describe('review regressions', () => {
    it.each([false, true])(
        'adds tsz through an existing trz with published plugin=%s',
        async (published) => {
            const f = await fixture({ published })
            await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
            await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
            f.options.bootstrapOnly = true
            f.options.settings.timeoutMs = 1200
            try {
                await f.operation.run()
            } catch (error) {
                throw new Error(`${error}\n${f.transcript().slice(-2500)}`)
            }
            expect(await fs.readFile(path.join(path.dirname(f.receiverPath), 'tsz'))).toEqual(
                f.sender,
            )
        },
    )
})

describe('review cancellation', () => {
    it.each([0, 50])(
        'has no delayed client writes after cancelling at %s ms and releasing the operation',
        async (cancelAfter) => {
            const f = await fixture({ published: true })
            await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
            await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
            const upload = f.client.uploadFiles.bind(f.client)
            f.client.uploadFiles = (paths) => {
                const result = upload(paths)
                setTimeout(() => f.operation.cancel(), cancelAfter)
                return result
            }
            const feed = f.operation.feedFromTerminal.bind(f.operation)
            let released = false
            const writes: string[] = []
            f.operation.feedFromTerminal = (data) => {
                if (released) writes.push(data.toString())
                else feed(data)
            }
            await expect(f.operation.run()).rejects.toThrow('取消')
            released = true
            await new Promise((resolve) => setTimeout(resolve, 400))
            expect(writes).toEqual([])
            expect(f.transcript()).not.toContain('::TRZSZ:TRANSFER:')
            await expect(fs.stat(path.join(f.destination, f.filename))).rejects.toThrow()
            expect(f.client.isTransferringFiles()).toBe(false)
            f.enableManual()
            f.child.stdin.write("printf 'SHELL_RECOVERED\\n'\n")
            await new Promise((resolve) => setTimeout(resolve, 100))
            expect(f.transcript()).toContain('SHELL_RECOVERED\r\n')
        },
    )

    it('cancels an active protocol without committing and restores shell input', async () => {
        const f = await fixture({ published: true })
        await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
        await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
        const feed = f.operation.feedFromTerminal.bind(f.operation)
        let cancelled = false
        f.operation.feedFromTerminal = (data) => {
            if (!cancelled && data.toString().startsWith('#DATA:')) {
                cancelled = true
                f.operation.cancel()
            }
            feed(data)
        }
        await expect(f.operation.run()).rejects.toThrow('取消')
        expect(cancelled).toBe(true)
        expect(f.client.isTransferringFiles()).toBe(false)
        await expect(fs.stat(path.join(f.destination, f.filename))).rejects.toThrow()
        expect(await fs.readdir(f.destination)).toEqual([])
        f.enableManual()
        f.child.stdin.write("printf 'SHELL_RECOVERED\\n'\n")
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(f.transcript()).toContain('SHELL_RECOVERED\r\n')
    })

    it('cancels a queued handshake before the client activates the protocol', async () => {
        const f = await fixture({ published: true })
        await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
        await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
        const feed = f.operation.feedFromSession.bind(f.operation)
        let cancelled = false
        f.operation.feedFromSession = (data) => {
            const output = feed(data)
            if (!cancelled && output.includes(Buffer.from('::TRZSZ:TRANSFER:'))) {
                cancelled = true
                f.operation.cancel()
            }
            return output
        }
        await expect(f.operation.run()).rejects.toThrow('取消')
        expect(cancelled).toBe(true)
        expect(f.client.isTransferringFiles()).toBe(false)
        await expect(fs.stat(path.join(f.destination, f.filename))).rejects.toThrow()
        expect(await fs.readdir(f.destination)).toEqual([])
        f.enableManual()
        f.child.stdin.write("printf 'SHELL_RECOVERED\\n'\n")
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(f.transcript()).toContain('SHELL_RECOVERED\r\n')
    })
})
