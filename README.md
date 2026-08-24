# @brendonovich/vite-plugin-opencode

Select elements in a Vite app and send source-aware UI feedback directly to
[OpenCode](https://opencode.ai/).

The plugin runs only during development. It adds source markers to JSX and TSX,
provides an in-browser element picker, and creates OpenCode sessions scoped to
the selected source file.

## Install

```sh
pnpm add -D @brendonovich/vite-plugin-opencode
```

## Usage

```ts
import { defineConfig } from "vite";
import opencode from "@brendonovich/vite-plugin-opencode";

export default defineConfig({
  plugins: [opencode()],
});
```

Start your Vite development server and make sure the OpenCode V2 background
service is running. Press `Cmd+Shift+K` on macOS or `Ctrl+Shift+K` elsewhere to
activate the picker, then select an element and describe the change.

Use `Cmd+Shift+D` or `Ctrl+Shift+D` to switch between direct changes and the
three-approach design mode.

## Options

```ts
interface OpenCodePickerOptions {
  readonly workspaceRoot?: string;
  readonly skills?: ReadonlyArray<string>;
  readonly agent?: string;
}
```

- `workspaceRoot`: Directory OpenCode should use. Defaults to the nearest Git
  repository containing the Vite root.
- `skills`: OpenCode skills to load when creating a session.
- `agent`: OpenCode agent used for new sessions. Defaults to `build`.

## Requirements

- Node.js 22 or newer
- Vite 6, 7, or 8
- A running OpenCode V2 background service
- JSX or TSX source for element-level source mapping

## License

MIT
