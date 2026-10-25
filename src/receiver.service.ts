import { Injectable } from '@angular/core'
import { PlatformService } from 'tabby-core'
import {
    ReceiverCache,
    receiverCacheDirectory,
    ReceiverStatus,
    ReceiverBinaries,
} from './receiver-cache'
import { ElectronNet, electronDownloader } from './download'
import { receiverDownloadURLs, ReceiverSourceSettings } from './models'

@Injectable({ providedIn: 'root' })
export class ReceiverService {
    private cache?: ReceiverCache

    constructor(private platform: PlatformService) {}

    get cacheDirectory(): string {
        return receiverCacheDirectory(this.platform.getConfigPath())
    }

    load(
        platform: string,
        architecture: string,
        signal: AbortSignal,
        status: ReceiverStatus,
        settings: ReceiverSourceSettings,
    ): Promise<ReceiverBinaries> {
        return this.getCache().get(
            platform,
            architecture,
            signal,
            status,
            receiverDownloadURLs(settings),
        )
    }

    prefetch(
        settings: ReceiverSourceSettings,
        signal: AbortSignal,
        status: ReceiverStatus,
    ): Promise<void> {
        return this.getCache().prefetch(signal, status, receiverDownloadURLs(settings))
    }

    private getCache(): ReceiverCache {
        if (!this.cache) {
            // Tabby's ElectronService does not expose remote at runtime, even
            // though some published typings declare it. Use the host bridge directly.
            // eslint-disable-next-line @typescript-eslint/no-var-requires -- Host-provided module, loaded on demand.
            const { net } = require('@electron/remote') as { net: ElectronNet }
            this.cache = new ReceiverCache(this.cacheDirectory, electronDownloader(net))
        }
        return this.cache
    }
}
