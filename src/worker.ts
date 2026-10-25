import decoder from '../scripts/bootstrap-decoder.sh?raw'
import worker from '../scripts/remote-worker.sh?raw'
import { quote, remotePath, receiverLocation } from './shell'

export interface WorkerOptions {
    token: string
    receiverDirectory: string
    destination: string
    filename: string
    fileSize: number
    executable: boolean
    overwrite: boolean
}

export function workerCommand(options: WorkerOptions): string {
    if (!/^[a-f0-9]{32}$/.test(options.token)) throw new Error('Invalid transfer token')
    if (!Number.isSafeInteger(options.fileSize) || options.fileSize < 0)
        throw new Error('Invalid file size')
    const receiver = receiverLocation(options.receiverDirectory)
    const script = [
        `token=${quote(options.token)}`,
        `receiver_dir=${receiver.directory}`,
        `bootstrap_receiver=${receiver.command}`,
        `destination=${remotePath(options.destination)}`,
        `filename=${quote(options.filename)}`,
        `file_size=${options.fileSize}`,
        `executable=${options.executable ? 1 : 0}`,
        `overwrite=${options.overwrite ? 1 : 0}`,
        decoder,
        worker,
    ].join('\n')
    // Keep physical lines short for canonical PTYs. No bracketed paste is used.
    // Make both installed commands available in this terminal's parent shell after the worker exits.
    return `sh -c '${script.replace(/'/g, `'"'"'`)}'; export PATH=${receiver.directory}:"$PATH"\n`
}
