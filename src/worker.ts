import decoder from '../scripts/bootstrap-decoder.sh?raw'
import worker from '../scripts/remote-worker.sh?raw'
import { quote, remotePath, receiverLocation } from './shell'
import { DEFAULT_RECEIVER_DIRECTORY, defaults, validateReceiverBufferSize } from './models'

export interface WorkerOptions {
    token: string
    receiverDirectory: string
    receiverBufferSize?: string
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
    const receiverBufferSize = validateReceiverBufferSize(
        options.receiverBufferSize ?? defaults.receiverBufferSize,
    )
    const receiverDirectory =
        (options.receiverDirectory || DEFAULT_RECEIVER_DIRECTORY).replace(/\/+$/, '') || '/'
    const senderPath = `${receiverDirectory === '/' ? '' : receiverDirectory}/tsz`
    const script = [
        `token=${quote(options.token)}`,
        `receiver_dir=${receiver.directory}`,
        `bootstrap_receiver=${receiver.command}`,
        `bootstrap_sender=${remotePath(senderPath)}`,
        `receiver_buffer_size=${quote(receiverBufferSize)}`,
        `bootstrap_only=${options.bootstrapOnly ? 1 : 0}`,
        `destination=${options.bootstrapOnly ? "''" : remotePath(options.destination ?? '')}`,
        `filename=${quote(options.filename ?? '')}`,
        `file_size=${options.fileSize ?? 0}`,
        `executable=${options.executable ? 1 : 0}`,
        `overwrite=${options.overwrite ? 1 : 0}`,
        decoder,
        worker,
    ].join('\n')
    const marker = `PT${options.token}`
    // The interactive shell records only this short launcher. A non-interactive child reads
    // the worker as data, then evaluates it only after receiving the complete script.
    const reader = [
        `_pt_report() { printf "\\036PT${options.token}:%s\\037\\n" "$1"; };`,
        'trap "_pt_report STOPPED" 0; trap "exit 130" 1 2 15;',
        '_pt_script=; _pt_nl=$(printf "\\nx"); _pt_nl=${_pt_nl%x};',
        '_pt_report SCRIPT_READY;',
        'while IFS= read -r _pt_line; do',
        `if [ "$_pt_line" = ${marker} ]; then eval "$_pt_script"; exit; fi;`,
        '_pt_script=$_pt_script$_pt_line$_pt_nl;',
        'done; exit 1',
    ].join(' ')
    // Keep payload lines short for canonical PTYs and export PATH in the parent shell.
    return ` sh -c ${quote(reader)}; export PATH=${receiver.directory}:"$PATH"\n${script}\n${marker}\n`
}
