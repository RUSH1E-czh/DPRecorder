# 安卓移植说明（进行中）

> 这份文档记录「把 DPRecorder 搬到安卓」做到哪儿了、还差什么、怎么编。
> 桌面构建方式不变（见根目录 `README.md`）。

## 一句话现状

**壳（Tauri 2 Android + 整套 Vue 界面 + Rust 后端的非渲染部分）已经跨平台化**：
`dpr` crate 现在按 target 分流依赖，Windows 专属代码全部按 `cfg` 关掉，安卓上程序目录换成
应用私有数据区，`open_external` 走系统 Intent。

**还没完成的是「引擎在安卓上跑起来」那一段**：实时预览要走 GL 表面，出片要走视频编码。
两者都不是改 `cfg` 能解决的，方案见下面「还差什么」。

⚠️ 这些改动**没有在本机编译验证过**（手机上没有 Rust 工具链，也没有 SDK/NDK；官方 NDK 只发
x86_64 主机版，arm64 机器上没法交叉编译）。第一次 `cargo tauri android build` 大概率还要修几处
编译错误 —— 这是预期的，不是「已经能装」。

## 为什么不是一条命令的事

| 环节 | 桌面怎么做 | 安卓上为什么不行 |
| --- | --- | --- |
| 出片（视频编码） | `render.rs` 里 100 多处调用**外部** `ffmpeg` 进程，帧从 stdout 管道喂进去 | Android 10+ 禁止应用从私有目录 exec 二进制（W^X），也没有系统自带的 `ffmpeg`；只能进程内编码 |
| 实时预览 | 把主程序再拉一份当子进程（`dpe-preview`），由它开 macroquad 窗口 | 应用不能随便 fork 子进程；GL 表面只存在于 Activity 的 window 上 |
| 引擎渲染 | macroquad/miniquad 开窗口 → `glReadPixels` 回读 | Tauri 的 Activity 是 WebView，没有 GL 表面；`dps-ui` 的 Android 入口要求 `NativeActivity` |
| 文件选择 / 输出目录 | 系统文件对话框 + 任意路径读写 | 只能读应用私有目录；外部文件要走 SAF（`ContentResolver`）；写共享存储要走 MediaStore |
| 托盘、文件关联、快捷键、拖拽 | Win32 / 注册表 / WebView2 | 无对等物 |

## 已经改完的部分

- `DPR/src-tauri/Cargo.toml`
  - `winapi` → `[target.'cfg(windows)'.dependencies]`；
  - `tauri-plugin-cli` / `-drag` / `-prevent-default` → 桌面专属 target 表；
  - `dps` 在桌面带 `video` 特性（`prpr-avc`，需要 FFmpeg 静态库），安卓**先不带**；
  - `sasa` 在安卓换成 `oboe` 后端（和 `DPS/dps-ui` 的写法一致）；
  - `tauri` 去掉没用到的 `tray-icon` 特性（它在移动端编不过）。
- `DPR/src-tauri/src/common.rs`
  - 新增 `android_root()` / `set_android_root()`；`exe_dir()` 在安卓上返回应用私有数据目录
    （先用系统给的 `TMPDIR` 的父目录兜底，`Builder::build()` 之后由 `app_data_dir()` 覆盖）。
    `config/`、`output/`、`tmp/`、`logs/`、`respack/`、`appendant/` 因此自动落到可写处。
- `DPR/src-tauri/src/lib.rs`
  - 插件链按平台拆开（桌面才装 drag / prevent-default）；`prevent_default` 的 `Flags` 导入同步 cfg；
  - WebView2 的两个环境变量与 `ensure_webview_data_dir()` 只在 Windows 生效；
  - 程序目录改用 `common::exe_dir()`，不再依赖 `std::env::current_exe()`；
  - `App::run` 只在桌面调用（移动端事件循环由 `mobile_entry_point` 驱动）；
  - 注册表相关（`reg_set_string` / `reg_has_value`）、`cmd /c start`、`rundll32`、`run_briefly`
    全部 `#[cfg(target_os = "windows")]`；
  - `set_pez_default` / `open_default_apps_settings` 在安卓上是同名桩（前端那一页不会 invoke 失败）；
  - `open_folder` 在安卓上返回一句明确的错误（不是「打开失败」这种含糊提示）；
  - `open_external` 多了 `AppHandle` 参数，安卓分支走 `tauri-plugin-opener` 的 `open_url`
    （即 `ACTION_VIEW`）。
- `DPR/src/platform.ts`：`currentPlatform()` / `isMobile()`，给前端判断平台用。
- `DPR/src/TasksView.vue`：移动端不再调 `startDrag`（插件不存在，调了必抛）。

## 还差什么（按优先级）

### 1. 引擎渲染：第二个 Activity（决定「能不能看见谱面」）

`DPS/dps-ui/src/lib.rs` 里已经有现成的安卓胶水（`Java_quad_1native_QuadNative_libActivityOn*`、
`setDataPath` / `setTempDir` / `setDpi` / `setChosenFile`），是上游 Phira 留下的。缺的是：

- 在 `gen/android` 里加一个 `NativeActivity`（类名要与那些 JNI 符号对齐：`quad_native.QuadNative`），
  由它在自己的 window 上跑 miniquad；
- 预览/渲染的入口（现在在 `dpr` crate 的 `dpe/` 与 `render.rs`）挪成一个可被该 Activity 调用的
  函数，命令从 WebView 通过 channel 送进去（现在是 stdin/stdout 协议 + 子进程）；
- 出片时要把回读的帧交给编码器，而不是 ffmpeg 的 stdin。

### 2. 出片：进程内编码（决定「能不能导出视频」）

两条路，选一条：

- **libav（推荐，和桌面同源）**：给 `DPS/prpr-avc` 加 encoder/muxer 绑定（它现在只有 decoder：
  `Video::open` / `demux_audio`），需要按 `aarch64-linux-android` 编 FFmpeg 静态库（含 libx264）
  放进 `DPS/prpr-avc/static-lib/`，再给 `dpr` 加一个 `Encoder` 抽象：桌面实现走 ffmpeg 命令行，
  安卓实现走 libav。桌面行为完全不变。
- **MediaCodec（省事，但功能打折）**：用 NDK 的 `AMediaCodec` + `AMediaMuxer` 直接硬编 H.264。
  不需要外部库，但编码器参数（CRF、preset、像素格式、多音轨混流）都要自己重做，
  和桌面的「指定编码器」设置对不上。

### 3. 文件进出：SAF

- 导入谱面：走 `ACTION_OPEN_DOCUMENT` 拿到 `content://`，复制进私有目录再解析；
- 导出结果：`ACTION_CREATE_DOCUMENT` 或 MediaStore 写入 `Movies/DPRecorder`；
- 服务端已有的「打开文件夹 / 在文件夹中显示」在安卓上保持禁用。

### 4. 界面适配

1920×1080 的桌面布局直接塞进手机屏幕会很挤：多窗口（编辑器、调试窗口）在安卓上是
「同进程另开窗口」还是「整页切换」，需要先定策略再改 Vue 那几处 `WebviewWindow` 调用。

## 怎么编（在你自己的 PC 上，这里才是真正验证的地方）

前置：Node.js + pnpm、Rust、Tauri 2 的 Android 环境（JDK 17、Android SDK + NDK、
`ANDROID_HOME` / `NDK_HOME`），以及 `cargo-tauri`：

```bash
cd DPR
pnpm install
cargo install tauri-cli --version "^2" --locked

# 生成并提交 gen/android（只跑一次；这个目录是【生成物】，本仓库故意不手写它）
cargo tauri android init

# 出 APK（arm64 真机）
cargo tauri android build --target aarch64 --apk
# 调试安装到已连接的设备
cargo tauri android dev
```

> 桌面出片仍然需要外部 `ffmpeg`；安卓这一侧**暂时不要**开 `video` 特性
> （`Cargo.toml` 里已经按 target 分开了，别手动加回去 —— 它要求 `prpr-avc` 的
> `aarch64-linux-android` 静态库，仓库里没有那份）。

如果 `cargo tauri android init` 之后 `gen/android` 里的 `applicationId` 不是
`com.daogemm.dpr`，以 `tauri.conf.json` 的 `identifier` 为准。

## 目录约定（安卓）

| 桌面上 | 安卓上 |
| --- | --- |
| `<exe 目录>/config` | `/data/user/0/com.daogemm.dpr/files/config` |
| `<exe 目录>/output` | `.../files/output` |
| `<exe 目录>/tmp` | `.../files/tmp` |
| `<exe 目录>/logs` | `.../files/logs` |
| `<exe 目录>/respack`、`/appendant` | `.../files/respack`、`.../files/appendant` |

资源（`assets/`、`config.toml`）由 `tauri.conf.json` 的 `bundle.resources` 打进 APK，
安卓上要读它们得走 AssetManager（也是第 3 项 SAF 那块要一起解决的）。
