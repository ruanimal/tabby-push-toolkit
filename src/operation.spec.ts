import { afterEach, describe, it, expect } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { randomBytes } from 'crypto'
import { TrzszFilter } from 'trzsz'
import { defaults, DEFAULT_BOOTSTRAP_PATH } from './models'
import { quote } from './shell'
import { OperationOptions, PushOperation, TransferClient } from './operation'
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
        ['-u', 'tests/pty-server.py', ...(options.shell ?? ['/bin/sh'])],
        {
            stdio: 'pipe',
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
    const receiverPath = path.join(root, 'receiver/trz')
    const receiver = options.receiver
        ? await fs.readFile(options.receiver)
        : Buffer.from(
              `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(require.resolve('trzsz/bin/trz.js'))} "$@"\n`,
          )
    const send = (buffer: Buffer): void => operation.feedFromTerminal(buffer)
    const client = options.published
        ? await publishedClient(send)
        : new TrzszFilter({
              sendToServer: (data) => send(Buffer.from(data)),
              writeToTerminal: () => undefined,
              chooseSendFiles: async () => {
                  throw new Error('Unexpected picker')
              },
              chooseSaveDirectory: async () => undefined,
          })
    const statuses: string[] = []
    const operationOptions: OperationOptions = {
        token: randomBytes(16).toString('hex'),
        receiverPath,
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
            receivers: [
                {
                    id: 'linux',
                    platform: 'Linux',
                    architecture: os.arch() === 'x64' ? 'x86_64' : os.arch(),
                    localPath: '/unused',
                    note: '',
                },
            ],
        },
        loadReceiver: async () => receiver,
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
        statuses,
        client,
        options: operationOptions,
        operation,
        transcript: () => transcript,
    }
}

describe('push over a real PTY', () => {
    it.each([false, true])(
        'bootstraps, uploads and commits using published plugin=%s',
        async (published) => {
            const f = await fixture({ published })
            try {
                await f.operation.run()
            } catch (error) {
                throw new Error(`${error}\n${f.transcript().slice(-4000)}`)
            }
            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
            expect(await fs.readFile(f.receiverPath)).toEqual(f.receiver)
            expect((await fs.stat(path.join(f.destination, f.filename))).mode & 0o100).toBe(0o100)
            expect(
                (await fs.readdir(f.destination)).filter((name) => name.startsWith('.push-')),
            ).toEqual([])
            expect(f.statuses.at(-1)).toBe('上传完成。')
        },
    )

    it('reuses an installed receiver without reading a local bootstrap', async () => {
        const f = await fixture({ data: Buffer.alloc(0), shell: ['/usr/bin/busybox', 'ash'] })
        await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
        await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
        f.options.loadReceiver = async () => {
            throw new Error('Must reuse existing receiver')
        }
        f.options.settings.receivers = []
        await f.operation.run()
        expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(Buffer.alloc(0))
    })

    it.each(['trz', '', 'configured-missing-path'])(
        'uses an installed PATH receiver with setting %j and no bootstrap configuration',
        async (configured) => {
            const f = await fixture({ published: true, minimalPath: true })
            const installed = path.join(f.bin, 'trz')
            // Installed wrappers need not implement --version; the transfer handshake validates them.
            const wrapper = Buffer.from(
                `#!/bin/sh\n[ "$1" != --version ] || exit 1\n${f.receiver.toString().split('\n').slice(1).join('\n')}`,
            )
            await fs.writeFile(installed, wrapper, { mode: 0o700 })
            f.options.receiverPath =
                configured === 'configured-missing-path' ? f.receiverPath : configured
            f.options.settings.receivers = []
            f.options.loadReceiver = async () => {
                throw new Error('Must use installed trz')
            }

            await f.operation.run()

            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
            expect(await fs.readFile(installed)).toEqual(wrapper)
            await expect(fs.stat(f.receiverPath)).rejects.toThrow()
            expect(f.statuses.some((status) => status.startsWith('引导接收端'))).toBe(false)
        },
    )

    it('bootstraps to the managed location when a command name is not installed', async () => {
        const f = await fixture()
        f.options.receiverPath = 'trz'
        await f.operation.run()
        const managed = path.join(f.root, DEFAULT_BOOTSTRAP_PATH.slice(2))
        expect(await fs.readFile(managed)).toEqual(f.receiver)
        expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
    })

    it('only asks for a bootstrap file when no installed receiver is found', async () => {
        const f = await fixture()
        f.options.settings.receivers = []
        await expect(f.operation.run()).rejects.toThrow('请设置已安装 trz 的路径')
        await expect(fs.stat(f.receiverPath)).rejects.toThrow()
    })

    it('refuses overwrite and keeps the existing destination intact', async () => {
        const f = await fixture()
        await fs.mkdir(f.destination)
        await fs.writeFile(path.join(f.destination, f.filename), 'original')
        await expect(f.operation.run()).rejects.toThrow('EXISTS')
        expect(await fs.readFile(path.join(f.destination, f.filename), 'utf8')).toBe('original')
    })

    it('does not commit when the client reports a failed protocol', async () => {
        const f = await fixture({ overwrite: true })
        await fs.mkdir(f.destination)
        const target = path.join(f.destination, f.filename)
        await fs.writeFile(target, 'original')
        f.client.uploadFiles = async () => {
            throw new Error('protocol failed')
        }
        await expect(f.operation.run()).rejects.toThrow('protocol failed')
        expect(await fs.readFile(target, 'utf8')).toBe('original')
    })

    it('rejects corrupt bootstrap acknowledgements', async () => {
        const f = await fixture()
        const original = f.operation.feedFromSession.bind(f.operation)
        f.operation.feedFromSession = (buffer) =>
            original(Buffer.from(buffer.toString().replace(/ACK:/g, 'ACK:9')))
        await expect(f.operation.run()).rejects.toThrow(/校验失败/)
        await expect(fs.stat(path.join(f.destination, f.filename))).rejects.toThrow()
    })

    it('cancels mid-bootstrap, removes staging files and restores shell input', async () => {
        const f = await fixture()
        // Make the bootstrap span several acknowledged chunks.
        f.options.loadReceiver = async () =>
            Buffer.concat([f.receiver, Buffer.from('#' + 'x'.repeat(4096) + '\n')])
        const originalStatus = f.options.status
        f.options.status = (status) => {
            originalStatus(status)
            if (status.startsWith('引导接收端')) f.operation.cancel()
        }
        await expect(f.operation.run()).rejects.toThrow('取消')
        expect(
            (await fs.readdir(path.dirname(f.receiverPath))).filter((name) =>
                name.startsWith('.push-'),
            ),
        ).toEqual([])
        await expect(fs.stat(f.receiverPath)).rejects.toThrow()
        f.child.stdin.write("printf 'SHELL_RECOVERED\\n'\n")
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(f.transcript()).toContain('SHELL_RECOVERED\r\n')
    })

    it.skipIf(!process.env.TRZ_BINARY)(
        'transfers against a native trz binary',
        async () => {
            const f = await fixture({
                published: true,
                receiver: process.env.TRZ_BINARY,
                data: randomBytes(256001),
            })
            try {
                await f.operation.run()
            } catch (error) {
                throw new Error(`${error}\n${f.transcript().slice(-4000)}`)
            }
            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
        },
        120000,
    )
})

describe('cancellation before startup', () => {
    it('does not send a command after cancellation', async () => {
        const sent: Buffer[] = []
        const client: TransferClient = {
            uploadFiles: async () => undefined,
            stopTransferringFiles: () => undefined,
            isTransferringFiles: () => false,
        }
        const operation = new PushOperation(
            {
                token: 'a'.repeat(32),
                receiverPath: '/trz',
                destination: '/tmp',
                filename: 'tool',
                fileSize: 0,
                executable: false,
                overwrite: false,
                localPath: '/tool',
                settings: defaults,
                loadReceiver: async () => Buffer.alloc(0),
                status: () => undefined,
            },
            client,
            (data) => sent.push(data),
        )
        operation.cancel()
        await expect(operation.run()).rejects.toThrow('取消')
        expect(sent.map((buffer) => buffer.toString())).toEqual(['\x03'])
    })
})
