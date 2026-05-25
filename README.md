# Call Graph Visualizer

An interactive VS Code extension that visualizes function call graphs using the VS Code LSP Call Hierarchy API.

## Features
- **Hierarchical & Distributed Layouts**: Supports clean top-down hierarchical layouts as well as compact distributed layouts.
- **Mouse Wheel Drag Panning**: Navigate the canvas smoothly by dragging with the middle mouse button (wheel click).
- **LSP & Static Analysis**: Precision parsing using the VS Code LSP Call Hierarchy, with a static regex-based parser as a fallback.
- **Jump to Source Code**: Double-click on nodes or connection edges to navigate directly to the respective location in the source code.
- **GitHub Dark Dimmed Theme**: Eye-friendly, modern dark dimmed aesthetics matching GitHub's color scheme.

## How to Use
1. Open a source file (e.g., Python `.py`).
2. Click the `Generate: Call Graph` icon in the editor title menu (top-right), or right-click in the editor and select `Generate: Call Graph` from the context menu.
