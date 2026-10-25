/** Removes framed control messages without interpreting binary protocol data as UTF-8. */
export class FrameParser {
    private pending = Buffer.alloc(0)
    private readonly prefix: Buffer

    constructor(
        token: string,
        private frame: (message: string) => void,
    ) {
        this.prefix = Buffer.from(`\x1ePT${token}:`)
    }

    feed(data: Buffer): Buffer {
        this.pending = Buffer.concat([this.pending, data])
        const output: Buffer[] = []
        while (this.pending.length) {
            const start = this.pending.indexOf(this.prefix)
            if (start === -1) {
                let keep = Math.min(this.prefix.length - 1, this.pending.length)
                while (keep && !this.pending.subarray(-keep).equals(this.prefix.subarray(0, keep)))
                    keep--
                output.push(this.pending.subarray(0, this.pending.length - keep))
                this.pending = this.pending.subarray(this.pending.length - keep)
                break
            }
            output.push(this.pending.subarray(0, start))
            this.pending = this.pending.subarray(start)
            const end = this.pending.indexOf(0x1f, this.prefix.length)
            if (end === -1) {
                if (this.pending.length > 4096) throw new Error('远端状态消息过长。')
                break
            }
            const message = this.pending.subarray(this.prefix.length, end).toString('utf8')
            this.pending = this.pending.subarray(end + 1)
            this.frame(message)
        }
        return Buffer.concat(output)
    }
}
