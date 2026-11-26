/**
 * 平台判断。
 *
 * DPR 现在是「一套前端 + 两套壳」：桌面是 Tauri 2 的 Windows/Linux/macOS 窗口，
 * 安卓是同一份前端装进 WebView（`cargo tauri android build`）。
 *
 * 安卓上缺的不是「能力弱一点」，而是几项**没有对等物**的桌面能力：
 *   - 把文件拖到资源管理器（`tauri-plugin-drag`，插件本身不支持移动端）；
 *   - 拦截 WebView 默认快捷键（`tauri-plugin-prevent-default`，同上）；
 *   - 「在文件夹中显示」/「打开输出文件夹」（安卓的应用私有目录别的应用进不去）；
 *   - 指定编码器、`ffmpeg` 目录之类的出片设置（安卓上没有可执行的 ffmpeg 进程）。
 *
 * 所以这些入口在移动端一律先判断再调，别让它们抛一个 invoke 失败出来。
 */

export type DprPlatform = 'android' | 'ios' | 'desktop'

/** 当前平台。安卓的 WebView 一定会在 UA 里带 `Android`，比读插件的注入值稳。 */
export function currentPlatform(): DprPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  return 'desktop'
}

/** 是不是移动端（安卓 / iOS）。桌面专属的入口都该先问一句。 */
export function isMobile(): boolean {
  return currentPlatform() !== 'desktop'
}

/** 安卓上「出片」还没接上进程内编码（见 `docs/ANDROID.md`），先按平台提示。 */
export function videoExportUnsupported(): boolean {
  return currentPlatform() === 'android'
}
