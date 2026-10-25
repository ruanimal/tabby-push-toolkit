import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider, TabContextMenuItemProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import TrzszModule from 'tabby-trzsz'
import { PushConfigProvider } from './config'
import { PushContextMenuProvider } from './menu'
import { PushSettingsTabProvider } from './settings'
import { PushSettingsComponent } from './settings.component'

@NgModule({
    // Explicitly import the dependency: Tabby's plugin scan is not recursive.
    // Angular deduplicates this module when the same tabby-trzsz is also discovered at top level.
    imports: [CommonModule, FormsModule, TabbyCoreModule, TrzszModule],
    providers: [
        { provide: ConfigProvider, useClass: PushConfigProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: PushContextMenuProvider, multi: true },
        { provide: SettingsTabProvider, useClass: PushSettingsTabProvider, multi: true },
    ],
    declarations: [PushSettingsComponent],
    entryComponents: [PushSettingsComponent],
})
export default class PushToolkitModule {}
