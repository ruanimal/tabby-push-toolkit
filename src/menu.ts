import { Injectable } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider } from 'tabby-core'
import { isSSHTerminal, PushService } from './push.service'

@Injectable()
export class PushContextMenuProvider extends TabContextMenuItemProvider {
    weight = 5
    constructor(private push: PushService) {
        super()
    }

    async getItems(tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (!isSSHTerminal(tab)) return []
        const status = this.push.status(tab)
        return [
            {
                label: 'Push Toolkit',
                submenu: status
                    ? [
                          { label: status, enabled: false },
                          { label: '取消上传', click: () => this.push.cancel(tab) },
                      ]
                    : this.push.settings.files.length
                      ? this.push.settings.files.map((file) => ({
                            label: file.name || file.localPath,
                            click: () => {
                                void this.push.push(tab, { ...file })
                            },
                        }))
                      : [{ label: '请先在设置 → Push Toolkit 添加常用文件', enabled: false }],
            },
        ]
    }
}
