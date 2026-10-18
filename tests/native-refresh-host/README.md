# Windows 原生刷新复现

此宿主只载入测试页面和合成的两份提示词，不读取 Magpie 设置。使用与当前官方 Windows Magpie 相同的 Wails `v3.0.0-beta.24`，保留官方插件页的 `sandbox="allow-scripts"`、CSP 和消息格式。它是原生页面复现工具，不是完整 Magpie 的替代测试。

在插件项目根目录操作。先用已有 Go 构建此目录到 `evidence/native-refresh-host.exe`，再启动资源服务：

```powershell
node tests/native-refresh-server.mjs native-fixture 127.0.0.2 18083 012
```

最后一个参数 `010` / `012` 从已有 Git 提交读取旧页面；省略则使用当前工作副本。资源服务仅绑定测试用的 `127.0.0.2:80`（或指定的 `.3`）和 18083 / 18084，不占用现用 Magpie 的 `127.0.0.1:80`。

用 `Start-Process -WindowStyle Hidden -PassThru` 启动独立诊断程序，参数为：

```text
--page-dir <项目绝对路径>/evidence/native-fixture/page
--cdp-port 14648
--loopback 127.0.0.2
--visible
```

诊断端口只监听回环地址；WebView 配置保存在诊断程序旁的 profile 文件夹。测试脚本只连接明确指定的诊断端口，不连接现用 Magpie。

```powershell
node tests/native-refresh-late-reply.mjs late-reply-012-before
node tests/native-refresh-stress.mjs 40 navigation-012
$env:KUPA_TEST_CYCLE_PAUSE='5000'
node tests/native-refresh-stress.mjs 120 navigation-012-soak
```

`native-refresh-late-reply.mjs` 在父窗口内部延迟前后两个 `options.get` 请求，先返回旧请求的错误，再返回新设置。这与官方 `pluginpages.js` 先捕获 `ev.source`、等待请求完成后再回复的行为一致。0.0.12 应失败：新页面初始化被旧错误打断。候选版应通过。对照 0.0.10 使用 `late-reply-010-remount remount` 参数，验证重建 iframe 时旧响应不会进入新页面。

第二套窗口使用 `127.0.0.3`、18084、14649，并通过 `KUPA_TEST_CDP_PORT=14649` 选择对应诊断端口。资源与程序分别放入独立子目录以隔离 WebView profile。CPU 采样只接受名称为 `native-refresh-host.exe` 的明确 PID：

```powershell
python tests/native-refresh-monitor.py --pid <诊断程序PID> --seconds 630 --output evidence/native-metrics.json
```

复现结果仅说明受控延迟回包、刷新、重建 iframe、主题切换和指定时间内的 CPU/页面响应情况；不证明所有 Magpie 功能、长时间运行的真实 profile 或 macOS 均无卡死。
