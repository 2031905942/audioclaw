import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createAudioTools } from "./audio-tools.js";

function fakeApi(params: {
  roots: Array<{ id: string; path: string }>;
  includeExtensions?: string[];
}): OpenClawPluginApi {
  return {
    runtime: { log: () => {}, warn: () => {}, error: () => {} },
    config: {
      agents: { defaults: { workspace: process.cwd() } },
    } as unknown as never,
    pluginConfig: {
      roots: params.roots,
      includeExtensions: params.includeExtensions ?? [".xml", ".wwu", ".cs", ".md"],
      exclude: ["/.git/", "/Library/", "/Temp/"],
      maxHits: 50,
      maxFileBytes: 200000,
      followSymlinks: false,
    },
  } as unknown as OpenClawPluginApi;
}

describe("game-audio tools", () => {
  it("finds wwise event + unity reference", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-"));
    const reqDir = path.join(base, "requirements");
    const wwiseDir = path.join(base, "wwise");
    const unityDir = path.join(base, "unity");
    await Promise.all([fs.mkdir(reqDir), fs.mkdir(wwiseDir), fs.mkdir(unityDir)]);

    const event = "UI_Activity_Event410Lottery_Draw";
    await fs.writeFile(path.join(reqDir, "audio.md"), `Need ${event} in bank UI.`, "utf8");
    await fs.writeFile(
      path.join(wwiseDir, "Events.wwu"),
      `<WorkUnit><Events><Event Name=\"${event}\" Id=\"123\"/></Events></WorkUnit>`,
      "utf8",
    );
    await fs.writeFile(
      path.join(unityDir, "Audio.cs"),
      `AkSoundEngine.PostEvent(\"${event}\", gameObject);`,
      "utf8",
    );

    const api = fakeApi({
      roots: [
        { id: "requirements", path: reqDir },
        { id: "wwise", path: wwiseDir },
        { id: "unity", path: unityDir },
      ],
    });

    const tools = createAudioTools(api);
    const check = tools.find((t) => t.name === "audio_check_event");
    expect(check).toBeTruthy();

    const result = await check!.execute("t1", { eventName: event });
    const parsed = JSON.parse(result.content[0].text) as any;
    expect(parsed.interpretation.requirementsMentioned).toBe(true);
    expect(parsed.interpretation.wwiseProbablyDefined).toBe(true);
    expect(parsed.interpretation.unityReferenced).toBe(true);

    await fs.rm(base, { recursive: true, force: true });
  });
});
