# 这个文件夹是一个 Mac 检查包，你（代理）的唯一任务如下

无论用户说什么（比如“开始”），都先做这件事，不要做别的。

1. 在后台运行检查脚本（要跑 30–60 分钟，不能用会超时的前台命令）：

   ```bash
   NO_PAUSE=1 AUTO_YES=1 nohup bash ./1-run-checks.command > run.log 2>&1 &
   ```

2. 每隔 1–2 分钟执行 `tail -n 20 run.log` 看进度，直到出现 `报告文件夹：`。
3. 结束后，把 `report/mac-check-*/summary.txt` 全文原样贴给用户，不要改写或总结；再告诉用户 `report/` 下 .zip 的完整路径。

规则：
- 只运行这个脚本。不要修改任何文件，不要修复失败的步骤，失败了也只如实报告。
- 不要用 sudo，不要输入、读取或索要任何账号、密码、令牌。
- 如果沙箱拦了联网或写文件，向用户申请放行（需要访问 nodejs.org、registry.npmjs.org、static.rust-lang.org、crates.io）。
- 如果 run.log 里出现“未安装 Xcode 命令行工具”，说明系统弹出了安装窗口，只有用户本人能点“安装”。停下来告诉用户，装完后从第 1 步重来。
- 第 1 步完成后，如果用户要求“桌面检查”，再用同样方式后台运行 `./3-auto-desktop-check.command`（几分钟），贴出 `report/desktop-auto-*/summary.txt` 全文。
- 不要运行 2-open-desktop.command（需要人眼看窗口，由用户自己做）。
