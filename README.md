# SF Dependencies Graph

Phase 2 VS Code extension for extracting downward Salesforce metadata dependencies from a selected local file or bundle and rendering them in an interactive webview mindmap.

## Current scope

- Local source only
- Direct + transitive dependencies
- Output includes both graph/tree JSON and an in-editor webview mindmap
- Expand/collapse happens directly on each node inside VS Code

## Supported metadata in phase 1

- LWC Bundle
- Aura Bundle
- Apex Class
- Apex Trigger
- Custom Label
- Custom Object
- Custom Field
- Custom Metadata Type
- Custom Metadata Record

## Dependency coverage in phase 1

- LWC -> other LWC via `c/...` imports
- LWC -> Apex via `@salesforce/apex/...`
- LWC -> Custom Label via `@salesforce/label/...`
- LWC -> Object or Field via `@salesforce/schema/...`
- Aura -> Aura/LWC references in markup
- Aura -> Apex controller via `controller="..."`
- Aura -> Custom Label via `$Label.c...`
- Apex Class / Trigger -> Apex Class via identifier matching
- Apex Class / Trigger -> Custom Label via `Label.Name`
- Apex Class / Trigger -> Custom Object, Custom Metadata Type, Custom Field via static schema tokens
- Trigger -> target Object via `trigger ... on ObjectName`
- Custom Object / Custom Metadata Type -> child Custom Fields
- Custom Field -> referenced Object via `<referenceTo>`
- Custom Metadata Record -> owning Custom Metadata Type by record name

## Output

Running `SF Dependencies Graph: Analyze Selection (Mindmap)` now does two things:

- opens an interactive dependency mindmap inside a VS Code webview
- writes the raw JSON artifact to `.sf-dependencies-graph/` inside the workspace

The mindmap currently supports:

- click node to inspect metadata type and source path
- double-click node to open the source file
- click the `+` / `-` circle on a node to expand or collapse that branch
- expand all / collapse branches from the sidebar
- dashed connectors for `confidence: low` heuristic edges
- shared dependencies may appear as lightweight reference nodes instead of repeating the full subtree

The exported JSON still contains:

- `graph.nodes`
- `graph.edges`
- `tree`
- `warnings`
- `assumptions`

## Confidence

- `high`: deterministic static match from syntax or metadata structure
- `low`: heuristic match, usually from Apex identifier scanning

`confidence: low` is useful because you can:

- highlight uncertain edges differently in a future mindmap
- filter them out when you want a stricter deployment checklist
- review only suspicious dependencies instead of checking every edge manually

## Run locally

1. Open this folder in VS Code.
2. Press `F5` to start an Extension Development Host.
3. In the host window, open a Salesforce DX project.
4. Right-click a metadata file or bundle and run `SF Dependencies Graph: Analyze Selection (Mindmap)`.

## Notes

- Static analysis only
- Dynamic Apex references are marked indirectly through low-confidence heuristic matches
- Phase 2 keeps the phase 1 JSON export so the visualization can be debugged against raw data
- Large projects now compact repeated subtrees in `tree` output to avoid payload blowups
- Good next targets after phase 1: Flow, Aura events/interfaces, Lightning Message Channel, Visualforce, Permission Set, FlexiPage, Email Template, Remote Site Setting, Named Credential
