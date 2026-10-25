export const RECEIVER_VERSION = 'v1.3.0'
export const RECEIVER_RELEASE_URL = `https://github.com/ruanimal/trzsz-rs/releases/tag/${RECEIVER_VERSION}`
export const RECEIVER_ARCHIVE = `trzsz-${RECEIVER_VERSION}-all-platform.tar.gz`

export interface ReceiverDownloadSource {
    id: string
    name: string
    url: string
}

export const RECEIVER_SOURCES: readonly ReceiverDownloadSource[] = [
    {
        id: 'github',
        name: 'GitHub',
        url: `https://github.com/ruanimal/trzsz-rs/releases/download/${RECEIVER_VERSION}/${RECEIVER_ARCHIVE}`,
    },
    {
        id: 'gitee',
        name: 'Gitee',
        url: `https://gitee.com/iponder/trzsz-rs/releases/download/${RECEIVER_VERSION}/${RECEIVER_ARCHIVE}`,
    },
]
