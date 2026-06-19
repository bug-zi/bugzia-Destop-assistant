import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //
  // 注意：端口必须避开 Windows 动态保留端口段（netsh interface ipv4
  // show excludedportrange protocol=tcp）。原默认的 1420 落在 1414–1513
  // 保留段内，绑定会抛 EACCES，故改用 1520。若以后某次重启 1520 也被
  // 抢占，可再换一个安全端口，并同步修改 src-tauri/tauri.conf.json 的 devUrl。
  server: {
    port: 1520,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1521,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
