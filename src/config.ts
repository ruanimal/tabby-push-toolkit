import { ConfigProvider } from 'tabby-core'
import { defaults } from './models'

export class PushConfigProvider extends ConfigProvider {
    defaults = { pushToolkit: defaults }
}
