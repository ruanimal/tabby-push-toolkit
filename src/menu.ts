import { Injectable } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider } from 'tabby-core'
import { isConnectedTerminal, PushService } from './push.service'

function getPushItems(tab: BaseTabComponent, push: PushService): MenuItemOptions[] {
    if (!isConnectedTerminal(tab)) return []
    const status = push.status(tab)
    return [
        {
            label: 'Push Toolkit',
            submenu: status
                ? [
                      { label: status, enabled: false },
                      { label: '取消当前操作', click: () => push.cancel(tab) },
                  ]
                : [
                      {
                          label: '引导传输端',
                          click: () => {
                              void push.bootstrap(tab)
                          },
                      },
                      { type: 'separator' },
                      ...(push.settings.files.length
                          ? push.settings.files.map((file) => ({
                                label: file.name || file.localPath,
                                click: () => {
                                    void push.push(tab, { ...file })
                                },
                            }))
                          : [
                                {
                                    label: '请先在设置 → Push Toolkit 添加常用文件',
                                    enabled: false,
                                },
                            ]),
                  ],
        },
    ]
}

@Injectable()
export class PushContextMenuProvider extends TabContextMenuItemProvider {
    weight = 5
    constructor(private push: PushService) {
        super()
    }

    async getItems(tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        return getPushItems(tab, this.push)
    }
}
