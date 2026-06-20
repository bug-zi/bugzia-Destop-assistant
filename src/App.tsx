import { getCurrentWindow } from "@tauri-apps/api/window";
import CommandCard from "./components/CommandCard";
import PetWindow from "./components/PetWindow";
import ResultWindow from "./components/ResultWindow";
import SettingsWindow from "./components/SettingsWindow";
import WaveformWindow from "./components/WaveformWindow";
import "./styles/theme.css";

/**
 * Single SPA, routed by Tauri window label. Each window loads index.html and
 * renders a different root: main (长条入口) / result (结果浮层) / settings (设置弹窗)
 * / waveform (桌面波形浮层) / pet (桌宠浮层).
 */
function App() {
  const label = getCurrentWindow().label;
  if (label === "result") return <ResultWindow />;
  if (label === "waveform") return <WaveformWindow />;
  if (label === "pet") return <PetWindow />;
  if (label === "settings") return <SettingsWindow />;
  return <CommandCard />;
}

export default App;
