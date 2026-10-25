import { SessionMiddleware } from 'tabby-terminal'
import { PushOperation } from './operation'

/** Installed at the wire end of the stack, ahead of tabby-trzsz, for one job only. */
export class PushMiddleware extends SessionMiddleware {
    constructor(private operation: PushOperation) {
        super()
    }

    feedFromSession(data: Buffer): void {
        const output = this.operation.feedFromSession(data)
        if (output.length) super.feedFromSession(output)
    }

    feedFromTerminal(data: Buffer): void {
        this.operation.feedFromTerminal(data)
    }
}

/** Blocks user input even during the gap before the protocol engine detects its handshake.
 * Protocol-generated writes originate inside the stack and bypass this terminal-end lock.
 */
export class PushInputLock extends SessionMiddleware {
    constructor(private cancel: () => void) {
        super()
    }

    feedFromTerminal(data: Buffer): void {
        if (data.includes(3)) this.cancel()
    }
}
