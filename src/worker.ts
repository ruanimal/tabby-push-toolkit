import decoder from '../scripts/bootstrap-decoder.sh?raw'
import worker from '../scripts/remote-worker.sh?raw'
import { quote, remotePath, receiverLocation } from './shell'

export interface WorkerOptions {
    token: string
    receiverPath: string
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
    const receiver = receiverLocation(options.receiverPath)
    const script = [
        `token=${quote(options.token)}`,
        `receiver=${receiver.command}`,
        `bootstrap_receiver=${receiver.bootstrapPath}`,
        `destination=${remotePath(options.destination)}`,
        `filename=${quote(options.filename)}`,
        `file_size=${options.fileSize}`,
        `executable=${options.executable ? 1 : 0}`,
        `overwrite=${options.overwrite ? 1 : 0}`,
        decoder,
        worker,
    ].join('\n')
    // Keep physical lines short for canonical PTYs. No bracketed paste is used.
    return `sh -c '${script.replace(/'/g, `'"'"'`)}'\n`
}
