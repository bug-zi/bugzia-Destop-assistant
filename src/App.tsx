import { getCurrentWindow } from "@tauri-apps/api/window";
import CommandCard from "./components/CommandCard";
import ResultWindow from "./components/ResultWindow";
import SettingsWindow from "./components/SettingsWindow";
import WaveformWindow from "./components/WaveformWindow";
import "./styles/theme.css";

/**
 * Single SPA, routed by Tauri window label. Each window loads index.html and
 * renders a different root: main (长条入口) / result (结果浮层) / settings (设置弹窗).
 */
function App() {
  const label = getCurrentWindow().label;
  if (label === "result") return <ResultWindow />;
  if (label === "waveform") return <WaveformWindow />;
  if (label === "settings") return <SettingsWindow />;
  return <CommandCard />;
}

export default App;
