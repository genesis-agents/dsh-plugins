# dsh-agent-presets

Agent presets kept under version control, published into the writable preset
root (`<dshHome>/.agent-presets`) at startup.

## Why a plugin at all

`dsh-agent-presets` in the harness only scans real directories: its discovery
filters with `Dirent.isDirectory()`, which is false for a Windows junction and
for a POSIX symlink, so linking the writable root back to a checkout is skipped
in silence. Configuring an extra root does not help either — `apps/cli`
overwrites `roots` with its own shipped root while composing the profile.
Copying at boot is therefore the supported way to keep presets in git, and it
is what the third-party `dsh-liangshen` plugin does.

Only ids this package owns are written. Anything else already in the writable
root is left alone, and nothing is ever deleted — including on unload, so
removing this plugin leaves the presets it published in place.

## What it ships

| Preset | What it is |
|---|---|
| `docs-writer` (文档模式) | The standard agent minus the shell: files, code and web search, todos |
| `swarm-sources` (信源蜂群) | The judging half of source collection, for the local source library |

Both are thin — a persona and a few config deltas over what the shipped presets
already do. `swarm-sources` in particular adds no tools: `dsh-agents-swarm`
registers `source_library_search` and `source_library_add` on the **global**
tools registry, so every preset already has them, including the built-in ones.
What it adds is an instruction to search the library before reaching for the
web, and `fetch: false` on the web tool.

They live here rather than in a repository of their own because a repository,
a sync plugin and a profile dependency is a great deal of machinery for two
YAML files that are mostly configuration deltas.

## Adding one

Create a directory with `agent.cordis.yml` (the composition) and `preset.yml`
(name, description, order). It is published on the next start.

`agent.cordis.yml` is an AGENT-PLANE composition: a row that publishes a
service MUST sit inside a group carrying an `isolate` realm, or it publishes
into the process-global root realm where another preset registering the same
name collides.
