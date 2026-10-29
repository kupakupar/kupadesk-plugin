# KupaDesk

为 [Magpie](https://usemagpie.ai) 提供核心（可复用提示词）管理，按模型和 Agent 应用。支持 Windows、macOS，需要有效卡密，无需 GitHub 账号。

## 主要功能

- 管理本机和云端核心，选择前置、追加或替换模式。
- 按模型及 Agent 绑定，查看注入结果和请求诊断。
- 支持亮暗主题、自定义壁纸、模型收藏和供应商筛选。

## 安装与激活

安装官方 Magpie，在插件安装框中粘贴：

```text
github:kupakupar/kupadesk-plugin
```

安装后打开 **KupaDesk → 云端**，输入卡密激活，再选择核心、绑定模型并保存设置。

## 更新

在 **插件 → 已安装** 中单独更新 KupaDesk，完成后使用 Magpie 顶部刷新，再打开 KupaDesk。准备期间页面会自动重试；以运行版本和状态为准。

## 使用说明

- 本机和云端核心均需要有效授权；需要恢复时，从「云端」进入恢复授权。
- 授权有效即可查看云端核心列表；「下载并使用云端正文」只控制已绑定核心的正文获取与使用。
- 自定义壁纸仅保存在当前电脑，其他电脑缺少图片时使用默认壁纸。
- 此仓库提供更新入口，运行核心在授权后下载；无需替换 Magpie 官方程序。

[查看更新日志](https://github.com/kupakupar/kupadesk-plugin/blob/main/CHANGELOG.md)
