import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider, TabContextMenuItemProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { PushConfigProvider } from './config'
import { PushContextMenuProvider } from './menu'
import { PushSettingsTabProvider } from './settings'
import { PushSettingsComponent } from './settings.component'

@NgModule({
    // Tabby loads the shared tabby-trzsz peer; importing it here could activate a second copy.
    imports: [CommonModule, FormsModule, TabbyCoreModule],
    providers: [
        { provide: ConfigProvider, useClass: PushConfigProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: PushContextMenuProvider, multi: true },
        { provide: SettingsTabProvider, useClass: PushSettingsTabProvider, multi: true },
    ],
    declarations: [PushSettingsComponent],
    entryComponents: [PushSettingsComponent],
})
export default class PushToolkitModule {}
