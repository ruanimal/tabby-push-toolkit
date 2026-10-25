import decoder from '../scripts/bootstrap-decoder.sh?raw'
import worker from '../scripts/remote-worker.sh?raw'
import { quote, remotePath, receiverLocation } from './shell'
import { DEFAULT_RECEIVER_DIRECTORY } from './models'

export interface WorkerOptions {
    token: string
    receiverDirectory: string
    destination?: string
    filename?: string
    fileSize?: number
    executable?: boolean
    overwrite?: boolean
    bootstrapOnly?: boolean
}

export function workerCommand(options: WorkerOptions): string {
    if (!/^[a-f0-9]{32}$/.test(options.token)) throw new Error('Invalid transfer token')
    if (
        !options.bootstrapOnly &&
        (!Number.isSafeInteger(options.fileSize) || (options.fileSize ?? -1) < 0)
    )
        throw new Error('Invalid file size')
    const receiver = receiverLocation(options.receiverDirectory)
    const receiverDirectory =
        (options.receiverDirectory || DEFAULT_RECEIVER_DIRECTORY).replace(/\/+$/, '') || '/'
    const senderPath = `${receiverDirectory === '/' ? '' : receiverDirectory}/tsz`
    const script = [
        `token=${quote(options.token)}`,
        `receiver_dir=${receiver.directory}`,
        `bootstrap_receiver=${receiver.command}`,
        `bootstrap_sender=${remotePath(senderPath)}`,
        `bootstrap_only=${options.bootstrapOnly ? 1 : 0}`,
        `destination=${options.bootstrapOnly ? "''" : remotePath(options.destination ?? '')}`,
        `filename=${quote(options.filename ?? '')}`,
        `file_size=${options.fileSize ?? 0}`,
        `executable=${options.executable ? 1 : 0}`,
        `overwrite=${options.overwrite ? 1 : 0}`,
        decoder,
        worker,
    ].join('\n')
    // Keep physical lines short for canonical PTYs. No bracketed paste is used.
    // Make both installed commands available in this terminal's parent shell after the worker exits.
    return `sh -c '${script.replace(/'/g, `'"'"'`)}'; export PATH=${receiver.directory}:"$PATH"\n`
}
