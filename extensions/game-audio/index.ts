import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createAudioTools } from "./src/audio-tools.js";

export default function register(api: OpenClawPluginApi) {
  for (const tool of createAudioTools(api)) {
    api.registerTool(tool);
  }
}
