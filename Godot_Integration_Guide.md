# Godot Game Development Suite — Integration Guide

**Version 1.2 | March 2026**

---

## 1. Executive Summary

This guide details how the Godot Game Development Suite skill works — what it does, how a Mind reads it, and what infrastructure is needed to run it.

The skill connects Godot Engine to any MCP-compatible AI agent (a "Mind") so the Mind can autonomously design, build, test, and iterate on 2D and 3D games from natural language descriptions. It exposes 28 tools across 6 categories and includes a 25-genre template library for rapid prototyping.

**What a Mind can do with this skill:**

- Match a user's game idea to one of 25 genre templates and clone a ready-made starter project
- Create scenes, add and configure nodes, write and attach GDScript files
- Run the game, capture screenshots, simulate player input for automated playtesting
- Read debug output, inject live GDScript for runtime debugging
- Manage sprites, textures, and mesh libraries

---

## 2. Architecture — How a Mind Uses This Skill

A Mind reads 4 JSON files (the "4-Layer Interface Contract") to understand and operate this skill. These are the only files that go into the registry. Nothing else is needed on the Mind's side.

| Layer | File | What the Mind Learns |
|-------|------|----------------------|
| **Layer 1** | `1_registry_offering.json` | "This skill exists, it does game development, it has 25 templates" |
| **Layer 2** | `2_app_manifest.json` | Full list of 28 tools, template keyword maps for genre matching, MCP auth config |
| **Layer 3** | `3_tool_schemas.json` | Exact JSON Schema for every tool — parameter names, types, required/optional, return shapes |
| **Layer 4** | `4_skill_playbook.json` | Step-by-step execution pipeline, behavioral constraints, template matching flow with genre keyword map |

**What the Mind does NOT read:** The 25 template JSON files (TPL-001 through TPL-025). Those live on the MCP server's disk. When the Mind wants to use a template, it calls the `Godot_ListTemplates` tool — the server reads the files and returns the list. The Mind already knows about all 25 genres because the keyword maps and matching logic are embedded in Layers 2 and 4.

```
┌──────────────────────────────────────────────────────┐
│                   MIND (AI Agent)                     │
│                                                      │
│  Reads 4 JSON files from the registry:               │
│                                                      │
│  Layer 1 → "What is this skill?"                     │
│  Layer 2 → "What tools and templates does it have?"  │
│  Layer 3 → "How do I call each tool?"                │
│  Layer 4 → "What's my step-by-step playbook?"        │
│                                                      │
│  Then makes MCP tool calls ──────────────────────┐   │
└──────────────────────────────────────────────────┼───┘
                                                   │
                                          JSON-RPC 2.0
                                          (stdio transport)
                                                   │
┌──────────────────────────────────────────────────▼───┐
│                  MCP SERVER                          │
│                                                      │
│  Godot Engine 4.x installed                          │
│  Template files on disk (25 genre starters)          │
│  Receives tool calls → executes against Godot →      │
│  returns results to the Mind                         │
└──────────────────────────────────────────────────────┘
```

---

## 3. Tool Reference (28 Tools)

### 3.1 Editor & Project Management (6 tools)

| Tool | Purpose |
|------|---------|
| `Godot_LaunchEditor` | Opens the Godot editor for a specified project, initializing the MCP bridge |
| `Godot_RunProject` | Executes the project in debug mode with the MCP runtime bridge injected |
| `Godot_StopProject` | Terminates a running project instance and removes the MCP bridge |
| `Godot_GetDebugOutput` | Retrieves console output, errors, and warnings from the running project |
| `Godot_GetProjectInfo` | Retrieves project metadata: name, engine version, scene/script/resource counts |
| `Godot_ListProjects` | Scans a directory recursively for `project.godot` files to discover available projects |

### 3.2 Scene Management (5 tools)

| Tool | Purpose |
|------|---------|
| `Godot_CreateScene` | Generates a new `.tscn` scene file with a specified root node type (Node2D, Node3D, Control, etc.) |
| `Godot_GetSceneTree` | Returns the complete hierarchical scene tree with node names, types, and parent-child relationships |
| `Godot_SaveScene` | Persists scene modifications to disk; supports save-as for creating scene variants |
| `Godot_ListProjectScenes` | Lists all scene files (`.tscn`, `.scn`) in the project with root node types |
| `Godot_GetProjectSettings` | Reads project configuration: display settings, input map, physics, rendering options |

### 3.3 Node Manipulation (5 tools)

| Tool | Purpose |
|------|---------|
| `Godot_AddNode` | Inserts a new node into a scene with configurable type, name, parent, and initial properties |
| `Godot_EditNode` | Modifies properties of an existing node: position, scale, rotation, colors, physics parameters |
| `Godot_DeleteNode` | Removes a node and all its children from a scene (destructive operation) |
| `Godot_GetNodeProperties` | Reads all properties of a specific node including transform, visibility, and custom properties |
| `Godot_LoadSprite` | Applies a texture to Sprite2D, Sprite3D, or TextureRect nodes |

### 3.4 Script Authoring (6 tools)

| Tool | Purpose |
|------|---------|
| `Godot_CreateScript` | Generates a new GDScript file with specified content or base class template |
| `Godot_ReadScript` | Returns the full source code of a GDScript file for analysis or debugging |
| `Godot_ModifyScript` | Replaces the contents of an existing GDScript file with new source code |
| `Godot_AttachScript` | Binds a GDScript file to a specific node in a scene, creating the logic-to-visual linkage |
| `Godot_ListProjectScripts` | Enumerates all GDScript files in the project with paths and base class metadata |
| `Godot_ExportMeshLibrary` | Converts a 3D scene into a MeshLibrary resource for GridMap-based level design |

### 3.5 Runtime & Testing (4 tools)

| Tool | Purpose |
|------|---------|
| `Godot_TakeScreenshot` | Captures a PNG screenshot of the game viewport for visual verification |
| `Godot_SimulateInput` | Executes batched input sequences: key presses, mouse clicks, UI clicks, action presses, waits |
| `Godot_GetUIElements` | Discovers all visible Control nodes with names, types, positions, and text content |
| `Godot_RunScript` | Executes arbitrary GDScript at runtime with full SceneTree access for live debugging |

### 3.6 Template System (2 tools)

| Tool | Purpose |
|------|---------|
| `Godot_ListTemplates` | Returns the available template library from the server; optionally filters by genre |
| `Godot_CloneTemplate` | Clones a template into a new project directory with a custom name, ready for customization |

---

## 4. Template Library (25 Genres)

### How Template Matching Works

When a user describes a game idea — for example, "make me a game where a cat jumps between platforms and collects fish" — the Mind doesn't just pick a template at random. It runs a keyword matching process:

1. The Mind tokenizes the user's description into individual words and phrases.
2. It compares those tokens against the keyword arrays defined for each of the 25 genres in Layer 2. For example, the Platformer genre has keywords like "platformer", "side-scroller", "jumping", "run and jump", "2D adventure".
3. For each genre, it calculates a **confidence score** between 0.0 and 1.0 based on how many keywords matched relative to the total keyword set. A description mentioning "jumping", "platforms", and "side-scroller" would score high against the Platformer genre but low against the Card Game genre.
4. If the highest-scoring genre exceeds the **0.6 confidence threshold** (meaning at least 60% match strength), the Mind selects that template. The 0.6 threshold prevents weak or ambiguous matches — if a description only vaguely relates to a genre, it's better to build from scratch than to start from a mismatched template.
5. If no genre reaches 0.6, the Mind skips templates entirely and builds the game from scratch using the standard tool pipeline.

### Genre Reference

| ID | Genre | Key Mechanics |
|----|-------|---------------|
| TPL-001 | Platformer | Side-scrolling, CharacterBody2D, TileMap levels, collectibles, coyote time jumping |
| TPL-002 | Top-Down RPG | 8-directional movement, NPC dialogue, inventory grid, quest flags |
| TPL-003 | Puzzle | Match-3 grid, cascade/refill logic, combo multipliers, level progression |
| TPL-004 | Endless Runner | Auto-scroll, procedural obstacle spawning, parallax backgrounds, difficulty ramp |
| TPL-005 | Space Shooter | Shmup with waves, power-ups, boss fights, bullet patterns |
| TPL-006 | Tower Defense | Path-based enemies, turret placement on grid, upgrade system, wave management |
| TPL-007 | Fighting | 1v1 with hitboxes/hurtboxes, combo system, special moves, health bars |
| TPL-008 | Racing | Top-down drift mechanics, lap tracking, AI opponents, checkpoint system |
| TPL-009 | Survival Horror | Flashlight mechanics, limited inventory, sanity/fear system |
| TPL-010 | Card Game | Deck building, turn phases, mana system, card effects, draw pile |
| TPL-011 | Visual Novel | Branching narrative, character sprites, save/load, multiple endings |
| TPL-012 | Farming Sim | Crop planting/growing, seasons, stamina, animal care, selling |
| TPL-013 | Rhythm | BPM-synced falling notes, accuracy grading, combo system |
| TPL-014 | Roguelike | Procedural dungeon generation, permadeath, loot tables |
| TPL-015 | Physics Sandbox | RigidBody2D objects, spawn/delete, force application, material properties |
| TPL-016 | City Builder | Zoning system, resource management, population/happiness |
| TPL-017 | Stealth | Vision cones, guard AI patrols, noise system, alert states |
| TPL-018 | Battle Royale | Shrinking zone, loot spawning, last-player-standing |
| TPL-019 | Metroidvania | Ability-gated exploration, room transitions, boss phases, map tracking |
| TPL-020 | Bullet Hell | Bullet patterns (circle, spiral, aimed), object pooling, graze system |
| TPL-021 | Sports | Soccer with RigidBody2D ball, AI formations, match timer |
| TPL-022 | Quiz | Multiple question types, JSON question bank, lifelines, streak system |
| TPL-023 | Virtual Pet | Needs decay with real-time persistence, evolution stages, mini-games |
| TPL-024 | Turn-Based Strategy | Grid-based tactics, BFS pathfinding, terrain bonuses, unit classes |
| TPL-025 | Idle Clicker | Exponential scaling, generators, prestige mechanic, offline earnings |

---

## 5. Game Development Workflow

### Phase 1: Template Matching

The Mind receives a game description from the user. It runs the keyword matching process described above against all 25 genres. If a match exceeds the 0.6 confidence threshold, the Mind calls `Godot_ListTemplates` to confirm the template exists on the server, then `Godot_CloneTemplate` to create a new project from that starter. If no genre scores high enough, the Mind skips templates and builds from scratch.

### Phase 2: Build & Customize

Whether starting from a template or from scratch, the Mind builds bottom-up. It creates or modifies scene files, constructs the node tree starting with structural elements (physics bodies, collision shapes), adds visual elements (sprites, meshes), and finally UI components. GDScript files are written following Godot conventions — extending the correct base class, implementing `_ready()` for initialization, `_process(delta)` for frame logic, and `_physics_process(delta)` for physics. Scripts are attached to nodes and all changes are saved before testing.

### Phase 3: Test & Iterate

The Mind runs the project, checks debug output for errors, and captures screenshots to verify visual correctness. It uses `Godot_SimulateInput` to automate playtesting — chaining key presses, mouse clicks, and UI interactions to exercise gameplay paths. When issues arise, `Godot_RunScript` injects diagnostic GDScript at runtime to query node states and test fixes without restarting. The build-test-fix loop continues until the game meets specifications.

```
User prompt
    │
    ▼
┌─────────────────┐
│ TEMPLATE MATCH  │  Keyword match against 25 genres
│                 │  Score ≥ 0.6? → Clone template
│                 │  Score < 0.6? → Build from scratch
└────────┬────────┘
         │
    ┌────▼────┐
    │  BUILD  │  Scenes → Nodes → Scripts → Assets → Save
    └────┬────┘
         │
    ┌────▼────┐        ┌─────────┐
    │  TEST   │ ─────► │  DEBUG  │
    │  Run    │        │  Fix    │
    │  Screenshot      │  RunScript
    │  Input Sim       └────┬────┘
    └────┬────┘             │
         │◄─────────────────┘  (iterate)
         │
    ┌────▼────┐
    │ DELIVER │  Stop → Save → Summary
    └─────────┘
```

---

## 6. Recommended MCP Servers

These are server-side infrastructure choices — separate from the 4-layer skill files that Minds read from the registry.

| Server | Language | Strengths | Best For |
|--------|----------|-----------|----------|
| **ee0pdt/Godot-MCP** | TypeScript | Most popular (70+ stars), comprehensive scene/script management, active community | Primary — best balance of features and maturity |
| **Erodenn/godot-runtime-mcp** | GDScript | Runtime focus, in-engine execution, input simulation, screenshot capture | Testing and playtesting automation |
| **bradypp/godot-mcp** | Python | Clean architecture, good script editing, Python ecosystem integration | Teams preferring Python-based MCP infrastructure |
| **Coding-Solo/godot-mcp** | Python | Project management, multi-project support, settings access | Project orchestration across multiple game projects |
| **GDAI MCP Server** | Python | Advanced scene tools, node manipulation, resource management ($19 one-time) | Complex scene composition workflows |

**Recommended setup:** Use ee0pdt/Godot-MCP as the primary server for scene and script management, with Erodenn/godot-runtime-mcp as a runtime extension for input simulation, screenshots, and live debugging. Both communicate via stdio transport and can be composed in a single MCP configuration.

---

## 7. Server-Side Deployment Requirements

This section is for whoever sets up the infrastructure that the Mind's tool calls will hit. The Mind itself doesn't need any of this — it just makes MCP calls and gets results back.

### 7.1 Godot Engine Installation

Godot 4.x must be installed on the server and accessible via CLI. The Mind's tools call Godot commands through the MCP server, so the engine binary needs to be in the system PATH or configured in the MCP server's settings.

- **Download:** https://godotengine.org/download (Linux Server build recommended)
- **Minimum version:** 4.0 (4.3+ recommended for full feature support)
- **Disk space:** ~40MB for the editor binary, plus project files

### 7.2 Virtual Framebuffer (Headless Rendering)

On headless Linux servers (no physical display), Godot needs a virtual framebuffer to render screenshots and run the editor. Without this, `Godot_TakeScreenshot` and `Godot_LaunchEditor` will fail.

- **Install:** `sudo apt-get install xvfb`
- **Run Godot under Xvfb:** `xvfb-run --auto-servernum godot --editor --path /path/to/project`
- **Resolution:** Set virtual display to at least 1280×720 for usable screenshots
- **Alternative:** Use Godot's `--headless` flag for operations that don't need rendering (script authoring, scene manipulation), and Xvfb only for screenshot/runtime tools

### 7.3 MCP Server Setup

One or both recommended MCP servers need to be running and accepting stdio connections:

- **ee0pdt/Godot-MCP:** Clone the repo, run `npm install`, configure the Godot project path in settings, start with `npx godot-mcp`
- **Erodenn/godot-runtime-mcp:** Install as a Godot plugin within the project, enable in Project Settings → Plugins, starts automatically when the project runs

The MCP configuration (typically `mcp.json` or equivalent) should list both servers so the Mind can route tool calls to the appropriate one.

### 7.4 Template Files on Disk

The 25 template JSON files (TPL-001 through TPL-025) must be placed in a `templates/` directory that the MCP server can read. The exact path depends on the server configuration, but the file structure should be:

```
<mcp-server-root>/
├── templates/
│   ├── platformer_2d.json       (TPL-001)
│   ├── topdown_rpg.json         (TPL-002)
│   ├── puzzle_game.json         (TPL-003)
│   ├── endless_runner.json      (TPL-004)
│   ├── space_shooter.json       (TPL-005)
│   ├── tower_defense.json       (TPL-006)
│   ├── fighting_game.json       (TPL-007)
│   ├── racing_topdown.json      (TPL-008)
│   ├── survival_horror.json     (TPL-009)
│   ├── card_game.json           (TPL-010)
│   ├── visual_novel.json        (TPL-011)
│   ├── farming_sim.json         (TPL-012)
│   ├── rhythm_game.json         (TPL-013)
│   ├── roguelike.json           (TPL-014)
│   ├── physics_sandbox.json     (TPL-015)
│   ├── city_builder.json        (TPL-016)
│   ├── stealth_game.json        (TPL-017)
│   ├── battle_royale.json       (TPL-018)
│   ├── metroidvania.json        (TPL-019)
│   ├── bullet_hell.json         (TPL-020)
│   ├── sports_game.json         (TPL-021)
│   ├── quiz_game.json           (TPL-022)
│   ├── virtual_pet.json         (TPL-023)
│   ├── turn_based_strategy.json (TPL-024)
│   └── idle_clicker.json        (TPL-025)
```

### 7.5 Security Sandboxing

Since Minds can execute arbitrary GDScript via `Godot_RunScript` and `Godot_CreateScript`, the server environment should be sandboxed:

- **File system:** Restrict Godot's file access to the project directory only. Use container isolation (Docker) or filesystem namespaces to prevent access to host system files.
- **Network:** Disable outbound network access from within Godot projects unless explicitly required. GDScript's `HTTPRequest` node can make arbitrary HTTP calls.
- **Process limits:** Set CPU and memory limits on the Godot process to prevent infinite loops or memory exhaustion from generated scripts.
- **Project isolation:** Each Mind session should get its own project directory. Don't share project directories across sessions to prevent cross-contamination.

### 7.6 System Requirements Summary

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Ubuntu 20.04+ / Debian 11+ | Ubuntu 22.04 LTS |
| CPU | 2 cores | 4+ cores |
| RAM | 2 GB | 4+ GB |
| Disk | 1 GB free | 10+ GB (for multiple projects) |
| Godot | 4.0 | 4.3+ |
| Node.js | 18.x (for ee0pdt MCP) | 20.x LTS |
| Display | Xvfb (headless) | Xvfb at 1920×1080 |

---

## 8. Use Cases

**Conversational Game Creation.** A user describes a game idea in natural language — "Make me a platformer where a cat collects fish." The Mind matches to TPL-001 (Platformer), clones it, swaps the character sprite, changes collectibles to fish, adds a score UI, and delivers a playable result. The user plays and requests iterations.

**Educational Game Generation.** Teachers describe learning objectives. The Mind matches to TPL-022 (Quiz) or builds from scratch, generating interactive educational games tailored to grade level and curriculum — math quizzes with animated feedback, history timelines, science simulations.

**Rapid Prototyping.** Game designers describe mechanics in plain language. The Mind produces playable prototypes within minutes using the closest genre template, compressing the concept-to-prototype cycle from days to minutes.

**Game Modding & Extension.** Users describe modifications to existing Godot projects — "Add a double jump to the player" — and the Mind reads the existing codebase, understands the architecture, and implements changes with proper integration.

**Automated QA & Playtesting.** Minds systematically test games by simulating input sequences that exercise gameplay paths, capturing screenshots at each step, and generating test reports identifying visual glitches, physics anomalies, and logic errors.

---

## 9. Skill Files

The skill is composed of the following files:

| Layer | File | Purpose |
|-------|------|---------|
| Layer 1 | `1_registry_offering.json` | Marketplace listing — tells the registry this skill exists |
| Layer 2 | `2_app_manifest.json` | Full tool inventory, template keyword maps, auth config |
| Layer 3 | `3_tool_schemas.json` | JSON Schema definitions for all 28 tools |
| Layer 4 | `4_skill_playbook.json` | Execution pipeline, constraints, genre matching logic |

**Not uploaded:** The 25 template JSON files are server-side deployment assets. They're referenced by Layers 2 and 4 so the Mind knows about them, but the actual files live on the MCP server's disk.

---

## Appendix: GDScript Quick Reference

This appendix exists so that anyone reviewing this skill — whether a developer setting up the MCP server or someone evaluating the skill's capabilities — can quickly understand what GDScript looks like and how Godot scripts are structured. The Mind itself doesn't need this reference (it already knows GDScript through its training), but it's useful context for understanding what the Mind generates when it uses tools like `Godot_CreateScript` and `Godot_ModifyScript`.

```gdscript
# Basic node script structure
extends CharacterBody2D

@export var speed: float = 200.0
@export var jump_force: float = -400.0

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta: float) -> void:
    # Apply gravity
    if not is_on_floor():
        velocity.y += gravity * delta

    # Handle jump
    if Input.is_action_just_pressed("ui_accept") and is_on_floor():
        velocity.y = jump_force

    # Handle movement
    var direction := Input.get_axis("ui_left", "ui_right")
    velocity.x = direction * speed

    move_and_slide()
```

**Naming conventions:** PascalCase for nodes and classes (`PlayerCharacter`, `EnemySpawner`), snake_case for variables and functions (`move_speed`, `_on_body_entered`).

**Key lifecycle methods:** `_ready()` for initialization, `_process(delta)` for per-frame logic, `_physics_process(delta)` for physics updates, `_input(event)` for input handling.

**Signal pattern:** `signal health_changed(new_health: int)` declared at class level, emitted with `health_changed.emit(current_health)`, connected with `node.health_changed.connect(_on_health_changed)`.

---

*Godot Game Development Suite v1.2 | Godot Engine 4.x*
