import { afterEach, describe, it, expect, vi } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { randomBytes } from 'crypto'
import { TrzszFilter } from 'trzsz'
import { defaults, DEFAULT_RECEIVER_DIRECTORY } from './models'
import { quote } from './shell'
import { OperationOptions, PushOperation, TransferClient } from './operation'
import { publishedClient } from './published-client.test-helper'
import { ReceiverCache, receiverCacheDirectory } from './receiver-cache'
import { RECEIVER_ARCHIVE } from './receiver-release'

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
        prompt?: string
        nativeDecoder?: boolean
    } = {},
) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "push-test ' -"))
    const bin = path.join(root, 'bin')
    await fs.mkdir(bin)
    const tools = ['sh', 'mkdir', 'rm', 'mv', 'ln', 'wc', 'chmod', 'stty']
    if (!options.minimalPath) tools.push('uname')
    if (options.nativeDecoder) tools.push('base64', 'cksum', 'cat')
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
                PTY_TEST_PS1: options.prompt ?? '',
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
    let displayed = ''
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
            displayed += output.toString()
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
        displayed: () => displayed,
    }
}

describe('push over a real PTY', () => {
    it.each([['/bin/sh'], ['/usr/bin/busybox', 'ash'], ['/bin/bash', '--norc']])(
        'bootstraps binary data with native Base64 under %j',
        async (...shell) => {
            const f = await fixture({ shell, nativeDecoder: true, published: true })
            // The initial exec delegates to the receiver before these extra binary bytes are read.
            const receiver = Buffer.concat([
                f.receiver,
                ...Array.from({ length: 16 }, () =>
                    Buffer.concat([
                        Buffer.from('#'),
                        Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
                        Buffer.from('\n'),
                    ]),
                ),
            ])
            f.options.loadReceiver = async () => ({ trz: receiver, tsz: f.sender })
            await f.operation.run()
            expect(f.statuses).toContain('使用原生 Base64 快速引导…')
            expect(await fs.readFile(f.receiverPath)).toEqual(receiver)
            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
        },
    )

    it.each([['/bin/sh'], ['/usr/bin/busybox', 'ash'], ['/bin/bash', '--norc']])(
        'preserves the shell prompt after bootstrap under %j without extra input',
        async (...shell) => {
            const prompt = 'PUSH_TEST_PROMPT> '
            const f = await fixture({ shell, prompt })
            f.options.bootstrapOnly = true
            // Allow the initial prompt to arrive before injecting the worker.
            await new Promise((resolve) => setTimeout(resolve, 100))
            await f.operation.run()
            await new Promise((resolve) => setTimeout(resolve, 100))
            expect(f.transcript()).toContain(prompt)
            expect(f.displayed()).toContain(prompt)
        },
    )

    it.each(['installed', 'sender', 'push'])(
        'preserves the prompt with the published client after %s',
        async (mode) => {
            const prompt = 'PUSH_TEST_PROMPT> '
            const f = await fixture({
                published: true,
                shell: ['/usr/bin/busybox', 'ash'],
                prompt,
            })
            await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
            await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
            if (mode === 'installed')
                await fs.writeFile(path.join(path.dirname(f.receiverPath), 'tsz'), f.sender, {
                    mode: 0o700,
                })
            f.options.bootstrapOnly = mode !== 'push'
            await new Promise((resolve) => setTimeout(resolve, 100))
            await f.operation.run()
            await new Promise((resolve) => setTimeout(resolve, 100))
            expect(f.displayed()).toContain(prompt)
            expect(f.statuses.at(-1)).toBe(mode === 'push' ? '上传完成。' : 'trz 和 tsz 已就绪。')
        },
    )

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
            expect(await fs.readFile(path.join(path.dirname(f.receiverPath), 'tsz'))).toEqual(
                f.sender,
            )
            expect(
                (await fs.stat(path.join(path.dirname(f.receiverPath), 'tsz'))).mode & 0o100,
            ).toBe(0o100)
            expect((await fs.stat(path.join(f.destination, f.filename))).mode & 0o100).toBe(0o100)
            expect(
                (await fs.readdir(f.destination)).filter((name) => name.startsWith('.push-')),
            ).toEqual([])
            expect(f.statuses.at(-1)).toBe('上传完成。')
        },
    )

    it.each([DEFAULT_RECEIVER_DIRECTORY, "~/custom ' $HOME/bin"])(
        'prioritizes a receiver in directory %j over PATH without a local bootstrap',
        async (receiverDirectory) => {
            const f = await fixture({
                data: Buffer.alloc(0),
                shell: ['/usr/bin/busybox', 'ash'],
                receiverDirectory,
            })
            await fs.mkdir(path.dirname(f.receiverPath), { recursive: true })
            await fs.writeFile(f.receiverPath, f.receiver, { mode: 0o700 })
            await fs.writeFile(path.join(f.bin, 'trz'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
            f.options.loadReceiver = async () => {
                throw new Error('Must reuse existing receiver')
            }
            await f.operation.run()
            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(Buffer.alloc(0))
        },
    )

    it.each(['', '~/custom/bin'])(
        'uses an installed PATH receiver with setting %j and no bootstrap configuration',
        async (configured) => {
            const f = await fixture({ published: true, minimalPath: true })
            const installed = path.join(f.bin, 'trz')
            // Installed wrappers need not implement --version; the transfer handshake validates them.
            const wrapper = Buffer.from(
                `#!/bin/sh\n[ "$1" != --version ] || exit 1\n${f.receiver.toString().split('\n').slice(1).join('\n')}`,
            )
            await fs.writeFile(installed, wrapper, { mode: 0o700 })
            f.options.receiverDirectory = configured
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

    it('bootstraps to the default directory when the setting is empty', async () => {
        const f = await fixture()
        f.options.receiverDirectory = ''
        await f.operation.run()
        const managed = path.join(f.root, DEFAULT_RECEIVER_DIRECTORY.slice(2), 'trz')
        expect(await fs.readFile(managed)).toEqual(f.receiver)
        expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
    })

    it('installs both commands into a custom directory without using the default directory', async () => {
        const f = await fixture({ receiverDirectory: "~/custom ' $HOME/bin/" })
        await f.operation.run()
        expect(await fs.readFile(f.receiverPath)).toEqual(f.receiver)
        expect(await fs.readFile(path.join(path.dirname(f.receiverPath), 'tsz'))).toEqual(f.sender)
        await expect(fs.stat(path.join(f.root, '.local/bin'))).rejects.toThrow()
        expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
    })

    it('propagates download failures without committing a receiver', async () => {
        const f = await fixture()
        f.options.loadReceiver = async () => {
            throw new Error('Download HTTP 404')
        }
        await expect(f.operation.run()).rejects.toThrow('Download HTTP 404')
        await expect(fs.stat(f.receiverPath)).rejects.toThrow()
    })

    it('cancels promptly while a receiver download is pending', async () => {
        const f = await fixture()
        let downloading!: () => void
        const started = new Promise<void>((resolve) => {
            downloading = resolve
        })
        f.options.loadReceiver = async (_platform, _architecture, signal) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                downloading()
            })
        const transfer = f.operation.run()
        await started
        f.operation.cancel()
        await expect(transfer).rejects.toThrow('取消')
        await expect(fs.stat(f.receiverPath)).rejects.toThrow()
    })

    it.skipIf(!process.env.TRZ_ALL_ARCHIVE)(
        'extracts the real v1.3.0 release through the cache and uploads with its receiver',
        async () => {
            const f = await fixture({
                published: true,
                receiverDirectory: "~/release tools ' $HOME/bin/",
            })
            const archivePath = process.env.TRZ_ALL_ARCHIVE
            if (!archivePath) throw new Error('Missing release test fixture')
            const archive = await fs.readFile(archivePath)
            const directory = receiverCacheDirectory(
                path.join(f.root, 'tabby-config', 'config.yaml'),
            )
            const download = vi.fn(async () => archive)
            const cache = new ReceiverCache(directory, download)
            f.options.loadReceiver = (platform, architecture, signal) =>
                cache.get(platform, architecture, signal, (status) => f.statuses.push(status))
            try {
                await f.operation.run()
            } catch (error) {
                throw new Error(`${error}\n${f.transcript().slice(-4000)}`)
            }
            expect(await fs.readFile(path.join(f.destination, f.filename))).toEqual(f.data)
            expect(
                (await fs.readFile(path.join(directory, RECEIVER_ARCHIVE))).equals(archive),
            ).toBe(true)
            expect(download).toHaveBeenCalledOnce()
            const offline = new ReceiverCache(directory, async () => {
                throw new Error('Must use cached archive')
            })
            expect(
                await offline.get(
                    'Linux',
                    os.arch() === 'x64' ? 'x86_64' : os.arch(),
                    new AbortController().signal,
                    () => undefined,
                ),
            ).toEqual({
                trz: await fs.readFile(f.receiverPath),
                tsz: await fs.readFile(path.join(path.dirname(f.receiverPath), 'tsz')),
            })
            // After the worker exits, the parent shell can run tsz directly through PATH.
            f.enableManual()
            f.child.stdin.write(`tsz -- ${quote(path.join(f.destination, f.filename))}\n`)
            const downloaded = path.join(f.downloads, f.filename)
            const deadline = Date.now() + 8000
            let complete = false
            while (Date.now() < deadline) {
                try {
                    if (
                        (await fs.stat(downloaded)).size === f.data.length &&
                        !f.client.isTransferringFiles()
                    ) {
                        complete = true
                        break
                    }
                } catch {
                    /* wait for the protocol to create the file */
                }
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
            expect(complete, f.transcript().slice(-2000)).toBe(true)
            expect(await fs.readFile(downloaded)).toEqual(f.data)
        },
        120000,
    )

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
        await expect(fs.stat(f.receiverPath)).rejects.toThrow()
        await expect(fs.stat(path.join(path.dirname(f.receiverPath), 'tsz'))).rejects.toThrow()
    })

    it.each([false, true])(
        'rejects corrupt bootstrap acknowledgements with native=%s',
        async (nativeDecoder) => {
            const f = await fixture({ nativeDecoder })
            const original = f.operation.feedFromSession.bind(f.operation)
            f.operation.feedFromSession = (buffer) =>
                original(Buffer.from(buffer.toString().replace(/ACK:/g, 'ACK:9')))
            await expect(f.operation.run()).rejects.toThrow(/校验失败/)
            await expect(fs.stat(path.join(f.destination, f.filename))).rejects.toThrow()
        },
    )

    it.each([false, true])(
        'cancels mid-bootstrap and restores shell input with native=%s',
        async (nativeDecoder) => {
            const f = await fixture({ nativeDecoder })
            // Make the bootstrap span several acknowledged chunks.
            f.options.loadReceiver = async () => ({
                trz: Buffer.concat([f.receiver, Buffer.from('#' + 'x'.repeat(4096) + '\n')]),
                tsz: f.sender,
            })
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
        },
    )

    it.skipIf(!process.env.TRZ_BINARY)(
        'transfers against a native trz binary',
        async () => {
            const f = await fixture({
                published: true,
                receiver: process.env.TRZ_BINARY,
                data: randomBytes(256001),
                nativeDecoder: true,
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
                receiverDirectory: '/tools',
                destination: '/tmp',
                filename: 'tool',
                fileSize: 0,
                executable: false,
                overwrite: false,
                localPath: '/tool',
                settings: defaults,
                loadReceiver: async () => ({ trz: Buffer.alloc(0), tsz: Buffer.alloc(0) }),
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
