# Game Audio (plugin)

Read-only tools to help an OpenClaw agent audit game audio configuration across:

- Audio requirements (tables/docs)
- Wwise project files
- Unity project files

This plugin is designed for **analysis only** (no writes, no exec).

## Configure

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "game-audio": {
        enabled: true,
        config: {
          roots: [
            { id: "requirements", path: "~/Projects/MyGame/AudioRequirements" },
            { id: "wwise", path: "~/Projects/MyGame/WwiseProject" },
            { id: "unity", path: "~/Projects/MyGame/UnityProject" },
          ],
          exclude: ["/Library/", "/Temp/", "/.git/", "/obj/", "/bin/"],
          includeExtensions: [
            ".md",
            ".txt",
            ".csv",
            ".tsv",
            ".json",
            ".yaml",
            ".yml",
            ".xml",
            ".wwu",
            ".cs",
            ".prefab",
            ".unity",
            ".asset",
          ],
          maxFileBytes: 2000000,
          maxHits: 200,
          followSymlinks: false,
        },
      },
    },
  },
  agents: {
    list: [
      {
        id: "game-audio",
        name: "Game Audio (Read-only)",
        // Strongly recommended: run this under an OS user that only has read access.
        tools: {
          // Strict mode: allowlist core + plugin tools only.
          // Note: allow: ["game-audio"] alone will be treated as additive and won't restrict core tools.
          allow: ["session_status", "game-audio"],
          deny: [],
        },
      },
    ],
  },
}
```

If you want additive behavior (keep your current tool policy and just add these tools), use:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          alsoAllow: ["game-audio"],
        },
      },
    ],
  },
}
```

## Tools

- `audio_roots`: list configured roots + status
- `audio_search`: search text across roots
- `audio_read`: read a file (root + relative path) with size limits
- `audio_check_event`: heuristic check for a Wwise event across requirements + Wwise + Unity

## Security notes

Even with tool policy, this plugin runs in-process with the Gateway. For stronger isolation:

- Run OpenClaw under a dedicated OS user with read-only filesystem permissions.
- Keep `tools.elevated.enabled=false` and do not allow `exec`.
