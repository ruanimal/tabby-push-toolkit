import { describe, it, expect } from 'vitest'
import { FrameParser } from './frames'

describe('framed status parser', () => {
    it('handles every split point, ignores echoed commands, and preserves binary bytes', () => {
        const raw = Buffer.from([0, 255, 0x1e, 1, 0x1f])
        const marker = Buffer.from('\x1ePTabcd:ACK:1:2:3:4\x1f')
        const wire = Buffer.concat([raw, marker, raw])
        for (let split = 0; split <= wire.length; split++) {
            const frames: string[] = []
            const parser = new FrameParser('abcd', (frame) => frames.push(frame))
            expect(
                Buffer.concat([
                    parser.feed(wire.subarray(0, split)),
                    parser.feed(wire.subarray(split)),
                ]),
            ).toEqual(Buffer.concat([raw, raw]))
            expect(frames).toEqual(['ACK:1:2:3:4'])
        }
        const frames: string[] = []
        const parser = new FrameParser('abcd', (frame) => frames.push(frame))
        const echo = Buffer.from("printf '\\036PTabcd:READY\\037\\n'\r\n")
        expect(parser.feed(echo)).toEqual(echo)
        expect(frames).toEqual([])
    })
})
