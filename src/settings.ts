import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { PushSettingsComponent } from './settings.component'

@Injectable()
export class PushSettingsTabProvider extends SettingsTabProvider {
    id = 'push-toolkit'
    icon = 'upload'
    title = 'Push Toolkit'
    getComponentType(): typeof PushSettingsComponent {
        return PushSettingsComponent
    }
}
