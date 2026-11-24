# Chat view: a rendered conversation as the main session view

## Goal

A Claude session should be readable the way the Claude Code web and desktop apps
are: prose in a proportional font, markdown rendered, code in boxed blocks, and the
page's own light or dark colours. Codeman should keep managing the session exactly
as it does today. The agent still runs in its tmux pane, and only the way the
browser shows that pane changes.

The Response Viewer already renders a conversation this way, and its output is the
look to keep. Its problem is placement: it is a sheet the user opens on demand,
it does not update while the agent works, and it cannot send a prompt. The chat
view moves that same rendering into the main area, keeps it live, and puts a
message box under it.

## What the user sees

Each Claude session gets two views of the same pane:

- **Chat** shows the conversation rendered by the Response Viewer's markdown
  pipeline, newest message at the bottom, with a message box underneath.
- **Terminal** is today's xterm.js pane, unchanged.

A toggle switches between them, and a keyboard shortcut does the same. The choice
is remembered per session on this device. A per-device setting picks which view a
new session opens in, so a user who prefers chat never has to switch by hand. The
setting defaults to Terminal. Chat replaces the main view and still sends some
dialogs to the terminal in phase 1, so nobody gets it without choosing it.

Your own prompts show in full when they are short. A prompt longer than about 12
lines, typically a pasted log or spec, shows its first 6 lines followed by
"Show all (N lines)", so a long paste does not fill the screen between two
answers. Keep-warm nudges are hidden, as Read My Mind already drops them, because
Codeman sent them and you did not.

While the agent works, the chat view shows a status line under the last message,
such as "Working: Bash". The transcript events carry only the tool's name, so the
status line names the tool and not the file it touches. When a turn ends, the new
answer appears as a rendered message.

The chat view always shows the session's current conversation. After `/clear` it
starts empty, as Claude itself does.

## Where the conversation comes from

Claude Code writes every session to a transcript file, one JSON object per line.
`GET /api/sessions/:id/last-response?context=full` already reads that file and
returns the whole conversation as prompt and response messages, each tagged with
its turn number. The Response Viewer's "More" button uses it today, so the chat
view needs no new reader for its first version.

That reader keeps only text. It drops tool calls, tool results and thinking blocks.
The chat view shows a turn's tool activity as one muted summary line, such as
"Read 9 files · edited 2 · ran 3 commands". A busy turn makes dozens of calls, and
a line per call would push the answer far down the page. Clicking the summary
expands it to one line per call ("Read src/session.ts", "Ran npm test"), and each
of those expands to show the call's input. For edits, the Edit history panel also
shows the diffs.

The summary needs every call, so the parser emits a `tool` message for each
`tool_use` block. The message type already exists for the CLIs whose conversation
Codeman reads from the pane.

Reading the whole file on every update gets slow for a long conversation. Phase 1
re-reads it, debounced, which is fine for typical sizes. Phase 3 adds a cursor, so
the browser asks only for messages after the last one it has.

## How the view stays live

The server watches a Claude session's transcript once a hook has reported the
transcript's path. Codeman installs those hooks in every Claude workspace unless
`workspaceHooksEnabled` is off. The watcher already emits an internal
`transcript:update` event whenever new lines arrive, but the server does not
broadcast it. Phase 1 adds a throttled SSE event for it, so the browser learns of
each new message while a turn is still running.

The chat view also listens for events the server already broadcasts:

- `transcript:tool_start` drives the status line. With parallel tool calls, the
  matching `transcript:tool_end` fires once, so the status line shows the most
  recent tool rather than counting calls.
- `session:working` and `session:idle` mark the start and end of a turn. They come
  from Codeman's idle detection, not from hooks, so they also work where no
  transcript watcher runs.

`transcript:complete` does not help here. It fires only for a `result` row, and an
interactive Claude transcript has none.

Where no watcher runs, the view refetches on `session:working` and `session:idle`
alone and so updates only at the start and end of each turn. Hooks switched off
leave no watcher. In a Docker case, the hook reports the transcript's path inside
the container, which the host cannot open, so there is no watcher either.

## How the user sends a prompt

The message box is a multiline text area. On a desktop, Enter sends and
Shift+Enter adds a line. On a touch device only the Send button sends, as in the
phone's Compose dialog.

A send posts the text and its Enter as one input to `POST /api/sessions/:id/input`
with `useMux: true`. The server then pastes the text through tmux, presses Enter,
and arms its submit check. That check re-presses Enter while the prompt still sits
in Claude's composer, which Claude 2.1.277 and later cause by ignoring Enter for 30
to 50 seconds after the composer appears.

The browser's WebSocket input channel cannot do this. It writes raw bytes straight
into the pane and never reaches the tmux path, whatever the frame asks for. So the
chat view does not use it for prompts, even though that channel queues input
across a dropped connection.

Each request carries a client id, made once per page load, and a sequence number.
A request that fails on the network is retried with the same pair, so the server
applies it once. A request the server refuses is not retried, and the text stays
in the message box. The submit check cannot always recognise a multi-line prompt in
the composer, so a long paste sent in those first seconds can still strand.

Claude Code stores a pasted prompt inside a `<pasted_content>` tag, and every
multi-line prompt sent through tmux is a paste. The chat view unwraps that tag
before rendering, or the markdown renderer would run the lines together.

The box also gets these controls:

- A stop button sends Esc, which interrupts the current turn.
- An attach button and drag-and-drop reuse the existing prompt upload route. The
  uploaded files' paths go into the chat message box, using the upload code's
  existing option to return paths instead of typing them into the pane.
- A slash command is sent as text. A command that opens a picker inside Claude's
  interface, such as a bare `/model`, shows nothing in the chat view. The user
  switches to the terminal to use the picker.

The terminal stays mounted and attached while Chat shows. The chat view is a layer
over the terminal's area, so the terminal keeps its size and switching views never
resizes the pane. The stop button uses the terminal's connection to send Esc. Any
focus that lands on the hidden terminal moves to the message box, so keys never
reach the pane unseen.

## Dialogs and questions

Claude sometimes stops to ask: a permission prompt, an AskUserQuestion with
options, a plan approval. The question appears in the transcript as a tool call,
but the dialog that answers it exists only in the pane.

Codeman's Approvals Inbox already detects these through Claude's hooks, reads the
options from the pane, and answers them with `POST /api/approvals/:id/answer`.
Its store runs even while the inbox setting is off. The chat view shows a pending
item for its session as a card at the bottom of the conversation, with one button
per option. A click goes through the same answer route, which re-reads the pane
before it types anything.

The pane can also need attention in ways the inbox cannot parse. For those, the
card says "Claude is waiting in the terminal" and offers a button that switches
to the terminal view.

Phase 1 shows that notice for every pending dialog, and the answer cards follow
in phase 2. Dialogs are rare enough for this order. Codeman starts Claude with
`--dangerously-skip-permissions` by default, so a session stops only for
Claude's own questions and plan approvals. A session started in another
permission mode stops for every permission prompt and sends each one to the
terminal until phase 2.

## Scope

The first version covers local Claude sessions in the single main view. Tiles in
the tile grid and the second pane of a split stay terminals.

Docker Claude sessions read their transcripts through the same route, because
the container bind-mounts the host's `~/.claude/projects`. That works only when the
folder existed when the container was created. They get no live updates mid-turn,
as described under "How the view stays live".

Remote SSH sessions are not covered. The route reads the local projects folder,
and a remote session's transcript lives on the remote host. The Edit history panel
already reads remote transcripts over its bounded ssh path, and phase 3 can reuse
it.

Codex and DeepSeek Harness also write structured transcripts, which Codeman
already reads, so they can follow in phase 3. The other CLIs keep the terminal view,
and their toggle is hidden. Codeman reads their conversation off the screen, which
is too coarse for a main view, or cannot read it at all.

Nothing changes for the agent itself. The tmux session, respawn, Ralph, hooks,
auto-compact and every other server feature work exactly as they do now.

## Phases

1. **Live chat view.** Add the Chat/Terminal toggle and the default-view setting.
   Broadcast transcript updates as a throttled SSE event. Render the full
   conversation with the Response Viewer's pipeline, refetch it on transcript and
   session events, and show the working status line. Add the message box with
   send, stop and attach. When Claude waits on a dialog, show the "waiting in the
   terminal" notice with its switch button.
2. **Dialogs and tool activity.** Show approval cards inline. Extend the transcript
   parser with tool messages and render each turn's calls as one expandable
   summary line.
3. **Scale and reach.** Add incremental fetching with a cursor. Extend the view to
   remote SSH sessions, Codex and DeepSeek Harness, and lay it out for phones,
   where the chat view could replace the terminal and accessory bar entirely.
