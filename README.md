# pi-ticktick

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects TickTick task manager to your AI assistant.

The extension registers tools that let the LLM query, create, and manage your TickTick tasks, lists, projects, habits, and focus records — all through natural language.

## What it does

The following tools become available in your pi session:

| Tool | Description |
|------|-------------|
| `ticktick_tasks` | Query tasks: list, search, filter by project/list/due date/priority |
| `ticktick_create_task` | Create a new task with title, description, due date, priority, tags, etc. |
| `ticktick_update_task` | Update an existing task (any field) |
| `ticktick_done_task` | Mark a task as completed |
| `ticktick_lists` | List/manage TickTick lists (inbox, collection, projects) |
| `ticktick_projects` | List/manage TickTick projects |
| `ticktick_habits` | List/manage habits |
| `ticktick_focus` | Query focus/meditation records |

Commands:
- `/ticktick` — View your current tasks and configuration status
- `/ticktick-setup` — Interactive token setup

## Setup

### 1. Get your TickTick API token

1. Open the [TickTick web app](https://www.ticktick.com)
2. Click your avatar → **Settings** → **Account** → **API Token**
3. Create and copy your token

### 2. Install the extension

```bash
# Build (requires Node.js 20+)
cd ~/workspace/pi-ticktick-extension
npm install
npm run build
```

### 3. Deploy

Copy the built extension to pi's extensions directory:

```bash
cp dist/ticktick.mjs ~/.pi/agent/extensions/ticktick.mjs
```

### 4. Add your token

Create the config file:

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/pi-ticktick-config.json << EOF
{
  "token": "YOUR_TICKTick_BEARER_TOKEN_HERE"
}
EOF
```

Or run `/ticktick-setup` in a pi session for interactive setup.

### 5. Start a new pi session

The tools will appear automatically. Try:

- "What tasks do I have today?"
- "Create a task: Buy groceries tomorrow at 5pm, high priority"
- "Mark task #42 as done"

## Configuration

**Config file:** `~/.pi/agent/pi-ticktick-config.json`

```json
{
  "token": "your-bearer-token-here"
}
```

The token is cached in memory for the session. Run `/ticktick-setup` to update it.

## Security notes

- The API token is stored as plain text in your config file. Treat it like a password.
- The token has the same permissions as your TickTick account.
- Token is not transmitted to any third party — only to `api.ticktick.com`.
- You can revoke the token anytime from TickTick Settings → Account → API Token.

## Development

```bash
cd ~/workspace/pi-ticktick-extension
npm install
npm run build

# Watch mode for development
node build.mjs --watch  # or add a watch script
```

The extension is a single bundled ESM file. The only external dependency is `@earendil-works/pi-coding-agent` (bundled at runtime by pi).

## API reference

The extension wraps the [TickTick Open API v1](https://api.ticktick.com/open/v1):

- **Tasks:** GET/POST/PUT `/tasks`, `/tasks/{id}`, `/tasks/{id}/done`
- **Lists:** GET/POST/PUT `/lists`, `/lists/{id}`
- **Projects:** GET/POST/PUT `/projects`, `/projects/{id}`
- **Habits:** GET/POST/PUT `/habits`, `/habits/{id}`
- **Focus:** GET `/focus`

Authentication via `Authorization: Bearer <token>` header.
