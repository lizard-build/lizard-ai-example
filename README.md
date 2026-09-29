# Lizard AI

Private monorepo: [lizard-build/lizard-ai](https://github.com/lizard-build/lizard-ai).

| Component | Location | Service |
| --- | --- | --- |
| Telegram gateway and HTTP API | `src/main.mjs`, `src/control.mjs`, `src/miniapp.mjs` | `bot` |
| Mini App | `web/` | Served by `bot` |
| User workers | `src/worker.mjs`, `src/bot.mjs` | `worker` |
| Shared runtime, storage and agent tools | `src/`, `skills/` | Used by both services |
| Checks and maintenance | `test/`, `scripts/`, `.github/workflows/` | Local and CI |

Both services build from the repository root and share one lockfile. `BOT_ROLE` selects the process role; source files stay together so runtime bundles and Mini App assets use the same revision.

A Telegram bot on Lizard (lizard.build), with access by owner approval. Each user gets separate Lizard Sandboxes compute, a volume, a ChatGPT login and database tables. A user's Telegram topics map to Codex threads and folders within that user's environment. Messages sent outside a topic offer buttons to choose an existing session; the original text, voice or attachment enters that session once after selection. Codex replies render common Markdown links, bold text and code; GitHub device codes include a Copy code button. Topic names have a 32-character limit, with an ellipsis for longer names. Only the first task message sets the name; later messages and manual titles keep it unchanged. Topics belonging to the same user are not security boundaries. Codex runs with Full Access and no tool permission prompts by default (`approvalPolicy: never`, `sandbox: danger-full-access`). The worker applies this to new and resumed threads and every new turn. Each user still has a separate sandbox and volume.

Lizard SDK controls Sandboxes and Persistent Volumes. Managed Postgres stores admission, routing, queues, locks and session state. The Codex model runs through each user's own ChatGPT account. The controller's Telegram token, database URL and Lizard API key never enter user environments. An optional OPENAI_API_KEY applies only to the owner's environment.

## Access and commands

Private chats require owner approval. Groups require an approved administrator to connect them; see Group chats below. Set TELEGRAM_OWNER_ID to the administrator's numeric Telegram ID. A new user sends `/start`; the bot sends the owner a request. The owner uses `/allow ID` or `/block ID`. `/users` lists up to 50 users and their state. Approval does not allocate compute or a disk until the user needs Codex. Blocking rejects new work and interrupts an active turn when its worker can reach it.

Enable Threaded Mode in the BotFather Mini App: Open → My bots → your bot → Bot Settings → Threads Settings.

User commands:

Bot messages and command descriptions use English. By default, Codex replies match the language of the user’s latest message.

- `/login`: sign in to the user's own ChatGPT through device-code login.
- `/new Name`: create a topic and Codex session.
- `/sessions`: list the user's sessions.
- `/status`: show state; checking a sleeping environment does not wake it.
- `/stop`: interrupt a task and cancel that topic's queued prompts.
- `/models`, `/model ID`: choose a model.
- `/archive`, `/resume`: archive or reopen a session, keeping files and history.
- `/answer ID text`: answer a Codex question.

Creating a Telegram topic records its title without waking compute or starting Codex. The first task starts the Codex thread after checking sign-in. A topic notice named `/login` does not create a coding session. Startup sends one notice in the request's topic; a capacity notice appears only when all compute slots are reserved.

The first task message sets the Telegram topic name using up to 32 characters, with whitespace collapsed. Commands do not name a topic. The name stays fixed for later messages; failed renames retry without blocking the task. The Telegram app controls the main chat tab label: Bot API supports renaming ordinary private-chat topics, but `editGeneralForumTopic` only applies to supergroups.

Repeated `/login` reuses a pending code for up to ten minutes. Login completion must match the saved attempt ID and Codex process generation. An expired or replaced attempt cannot clear a newer login or report its failure against the new code.

Approval buttons check the sender, private chat, topic, request ID and runtime generation. Equal topic numbers in two users' chats do not collide. Text, voice, photos and document uploads work, with streamed replies. Generated files return as Telegram documents; see Telegram reply UX below.

Photos and documents up to 20 MB download through the controller and stay under `/workspace/sessions/<topic>/attachments/<update>`. Captions become task text; a caption starting with a slash never runs a bot command. Images also enter Codex as `localImage` input; other files enter as local paths. The queue stores these inputs in Postgres, and the user’s volume keeps the files across sandbox removal. The controller uses base64 chunks because the installed SDK file transport handles text only, then verifies the bytes with SHA-256 before saving. Telegram credentials never enter the sandbox. Each album item arrives as its own task. Oversized uploads and attachments outside a topic do not wake compute.

Voice messages under three minutes and 4 MB use `openai/gpt-4o-mini-transcribe` through OpenRouter. Set `OPENROUTER_API_KEY` on the worker service only. The worker sends audio directly to OpenRouter, with no language hint, so Russian, English and mixed speech stay in their original language. The key and audio never enter a user's Sandbox. This path no longer installs or runs Whisper; old model caches remain untouched. Telegram duration metadata and downloaded bytes enforce the limits. Requests time out after 75 seconds and do not retry automatically. Transcripts persist in the user's PostgreSQL schema to avoid repeated calls after successful delivery. The bot edits the transcription status into a 🎤 italic transcript, replying to the original voice message, in private chats and groups. A separate model reply follows. Transcripts enter the same topic queue as text, can answer questions and can set the first topic name. Spoken slash commands remain task text, so they cannot trigger bot administration commands.

## Storage and workers

The gateway polls Telegram and commits updates with its offset. It handles admission and sends the durable outbox. Only one gateway can hold the PostgreSQL gateway lock. Workers claim users through separate PostgreSQL session locks, so two workers cannot drive the same user at once. A lost lock connection terminates the process rather than allowing it to keep running unlocked.

The control schema contains users, incoming updates and outgoing messages. Each approved user gets a `tenant_<Telegram ID>` schema. The original owner's tables stay in `public`; the existing volume and sandbox IDs are adopted without moving files or login state. Database schemas separate routing, but all controller processes use a trusted database role. User Sandboxes have no database credential.

Each worker runs several users concurrently. Messages within a topic run in order; different topics may run concurrently within the per-user turn limit. A slow browser install or model task does not block the gateway or other users. The gateway sends to up to ten chats in parallel and spaces message chunks within a chat. Telegram delivery is at least once: a lost acknowledgement can cause a duplicate reply.

The deployment uses service `bot` with `BOT_ROLE=gateway` and service `worker` with `BOT_ROLE=worker`, each at one replica. To scale, add worker replicas or services with the same bot, project and database configuration. Keep the gateway at one replica. Worker locks and the global compute reservation apply across processes. `BOT_ROLE=all` remains available for a single-service deployment. Start with the limits below and measure before raising them; no large-load capacity claim has been validated.

## Environment lifecycle

The first Codex operation reserves a global compute slot, gets or creates that user's volume, and starts the `codex` template. Before Codex starts, the worker restores `lizard`, `gh` and `agent-browser` from versioned directories under `/workspace/.tools`. It installs Lizard CLI 4.0.6, GitHub CLI 2.101.0 and agent-browser 0.27.0 there on first use; the GitHub CLI archive must match its pinned SHA-256 digest. Chromium, browser libraries and fonts also live on the user volume. A replacement sandbox restores executable links, library paths and font configuration, then starts Codex. A versioned runtime bundle on the volume restores the environment with one SDK exec call. It checks saved executable paths without launching CLI version commands or a test browser. It skips package installation and browser downloads when the saved tools are ready. npm caches and package archives remain disposable to avoid wasting volume space. Version and platform changes use separate directories; old versions are retained. CLI installation does not sign users in or share accounts. No resource key from the controller is injected into it. All communication uses Lizard SDK and a loopback-only bridge.

After 30 minutes without activity, a worker deletes an idle sandbox and keeps its disk. It first checks incoming messages, prompts, active turns, pending approvals and device login. It closes that user's browsers, flushes files, verifies the volume attachment, deletes only that sandbox and waits for detach. A new message starts a replacement with the same disk. Active turns reconnect at startup; idle Codex threads resume only when they receive a task, so unused topics do not delay other work. Running processes and packages outside `/workspace` do not survive. The bot-managed CLIs and browser assets under `/workspace/.tools` do survive.

Active tasks and pending approvals prevent idle deletion. Default task duration is at most four hours; approval waits are at most one hour, after which the worker requests interruption. Device login protects the environment for ten minutes. These limits are configurable.

Sandboxes also receive a two-hour lifetime, renewed every ten minutes by a live worker. If the controller stops for a long time, this bounds orphaned compute; an active process may then be lost. Files and Codex history on `/workspace` remain. Volumes are never deleted by idle cleanup and continue to incur storage charges. Backups and a disk-retention policy require separate setup.

The worker stores an allocation attempt before creating compute. If a reply is lost, it reconnects using the user's volume attachment (`attachedSandboxId` on the current platform). If it cannot establish what happened, it holds the reservation and alerts the owner instead of creating another sandbox. Calls with an uncertain side effect are not replayed automatically.

## Group chats

Add the bot to a group as an ordinary member; it does not need admin rights. An approved user who is also a group admin sends `/connect@BOT_USERNAME`. We verify their role through `getChatAdministrators`, which does not require the bot to be an admin. Each connecting admin can create up to five group connections. After connection, **every group member** can ask for work by replying to one of the bot's messages. With Group Privacy disabled, mentions work too. Other bots and anonymous senders cannot start tasks. Group commands have their own Telegram command menu.

For mentions and full conversation context, the bot owner must disable Group Privacy in BotFather (`/setprivacy` → select the bot → Disable). Telegram requires adding the bot to the group again for this change to take effect. After re-adding it, the original connecting admin sends `/connect@BOT_USERNAME` again; saved files stay in place. With privacy enabled, use explicit commands such as `/status@BOT_USERNAME` or replies to the bot; Telegram will not deliver the full conversation. See [Telegram privacy mode](https://core.telegram.org/bots/features#privacy-mode).

Each group gets its own tenant, database schema, Persistent Volume and Sandbox. Personal files, saved accounts and API keys are not copied into it. With workspace provisioning enabled, the existing provisioner creates a separate group workspace and `agent-state` project. The managed-key feature flag stays unchanged. Group work uses the same compute, queue, turn and idle limits as private work. Ordinary conversation updates the history without waking compute or extending its idle timer.

The connecting admin uses `/login@BOT_USERNAME` to sign in to ChatGPT for the group. The code and Copy button go **only to that admin's private chat**. The signed-in account powers shared group tasks; use an account intended for all members. `/disconnect@BOT_USERNAME` is available to group admins. Removing the bot or blocking its connecting admin also stops new work and replies. Saved files remain; reconnection keeps the original group owner.

An ordinary group uses one Codex session. In forum groups, each Telegram topic gets a separate session within the group's shared environment. The bot does not rename group topics. Clarification buttons work for all members. A text answer must reply to the exact pending question; unrelated mentions and replies to old questions cannot consume it.

Group admins can send `/reset@BOT_USERNAME` to start a fresh conversation in the current topic. The bot cancels queued tasks, expires pending questions and waits for the current task to stop before confirming the reset. The next task starts a new Codex thread in the same folder. Files, apps, sign-ins, model settings and stored history stay in place. Earlier group messages are excluded from both automatic context and the new session's history search, including quoted replies. Other topics keep their sessions. A reset does not retry past tasks or change model safety checks.

`/settings@BOT_USERNAME` opens the same Mini App with **Apps, Settings and Data for that group**. Current group admins can edit shared AGENTS.md, language, model, reasoning effort, streaming and idle time. Explicit per-topic model choices still take priority. Group settings do not change personal settings, and reading or saving preferences does not wake a Sandbox.

Telegram does not support a `web_app` button in a group. When `getMe` reports a Main Mini App at gateway startup, the group button uses a `startapp` link to open it directly. Otherwise it opens a private `/start group_ID` handoff, where the bot shows a Web App button for that group. This fallback needs no BotFather changes and works for group admins without a personal bot account. The Mini App shows the group name and opens its Settings tab. Each API request verifies the Telegram signature, active group connection, sponsor admission and current admin role; a copied link never grants access. Apps and Data use the same group scope and checks.

### Conversation context

Managed Postgres keeps a searchable window of up to 20,000 messages per group from the last 90 days. Cleanup runs hourly and on writes. Each record includes the speaker, date, topic and reply target. Edits update history without rerunning tasks. Telegram does not supply history from before connection or message-deletion events; removing a message in Telegram does not remove its saved copy. This window is separate from saved Codex tasks, which may contain quoted context and remain on the group volume and in its task tables.

For each addressed task, the worker selects recent conversation, up to eight messages in the reply chain, and relevant older messages using PostgreSQL full-text search. The combined context has a 20,000-character budget. Codex can call `telegram_group_history` to search or page through older messages in this group, with a 24,000-character response budget. It cannot choose another group or read a private conversation. History enters as attributed, untrusted data; only the addressed message is a new task.

Unaddressed voice, photo, video and file messages contribute metadata, not transcripts or extracted content. Addressed voice and attachments use the existing transcription and file pipeline. New members can ask about retained group history, so treat it as shared with the whole group. Telegram privacy mode must be disabled, or the bot must be an admin, to capture ordinary messages: [Telegram FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).

## Browser and skills

Lizard Skill and agent-browser are installed for every user. Their skill files live under `/workspace/.telegram-codex/skills`, with links in `/etc/codex/skills`. Lizard Skill comes from `lizard-build/skill`, commit `6ae317035a314a16d8a289882e81fa740f50f160`, and loads the guide matching the installed CLI.

Bootstrap installs agent-browser 0.27.0, Chrome and Debian system libraries, then checks that Chrome launches. The template must include Debian 12, root access for bootstrap, npm, flock, Lizard CLI, Codex and Node with node:sqlite. Cold starts include this setup and may take several minutes. A future tested custom template can remove that cost; the current code does not assume one exists.

Codex receives browser instructions: use a topic-specific session and store the browser profile in `/workspace/sessions/<topic>/.browser-profile`. Browser pages are untrusted data. No public browser or Codex port is exposed. Browser credentials must stay on that user's volume. Lizard Skill does not grant access to an account; each user needs their own Lizard login for deployments. Do not put the bot operator's broad platform key inside a user's environment.

## Limits

See `.env.example` for all settings. Defaults:

| Setting | Default |
| --- | --- |
| Approved users | 100 |
| Active or reserved Sandboxes across all workers | 10 |
| Users handled concurrently by one worker process | 10 |
| New user volume | 2 GB |
| Active topics per user | 20 |
| Queued messages per user | 20 |
| Active turns per user | 2 |
| Incoming messages per user | 20/minute |
| Input text | 16,000 characters |
| Idle deletion | 30 minutes |

Creating a chat at the active-topic limit automatically archives the least recently used idle session. Running turns, queued messages and tasks, pending questions and sign-in attempts prevent automatic archival. If every session is busy, the bot asks the user to wait. Archival removes a session from the bot's active list without deleting its Telegram topic, files or Codex history. Use `/resume` in the old topic to reopen it when there is room.

These are resource limits, not a currency spending cap. ChatGPT usage belongs to the user's account; compute and storage belong to the operator's Lizard project. Pending admission requests allocate no Sandboxes or volumes. Pending requests are bounded separately to limit unsolicited database growth.

## Deployment and checks

Use Node 24+ for the controller. Run `npm ci` for local development and keep service-scoped secrets on Lizard using `.env.example` as the key list. Never commit a filled `.env` or login files.

The `codex-telegram` project deploys both existing services from this private repository's `main` branch. Lizard builds with lizardpack and starts `npm start`. The `bot` service uses `BOT_ROLE=gateway` and port 3000; `worker` uses `BOT_ROLE=worker` and port 0. The gateway serves the Mini App at `/settings` and a readiness check at `/healthz`. The worker's health endpoint is internal. Health checks confirm the controller role, not each user's availability.

Push changes to `main` for automatic deployment through the Lizard GitHub integration. GitHub Actions runs syntax checks and all tests against a disposable PostgreSQL database on pushes and pull requests. These checks report separately from the deployment; the GitHub webhook does not wait for CI, so run checks before pushing to `main`.

`deploy/lizard.json` records the source, branch, build root and ports. To restore those settings on the existing services, run:

```sh
lizard service set --project YOUR_PROJECT_ID --file deploy/lizard.json --json
```

Source changes rebuild running services automatically. Do not follow that change with another deploy. To rebuild an unchanged revision deliberately, use `lizard redeploy --service bot --json` or `lizard redeploy --service worker --json`. Do not use `lizard up` for these services: it switches their source back to an uploaded archive.

The GitHub migration keeps service IDs, the public URL, secrets, Managed Postgres and users' Persistent Volumes. GitHub contains source and tests only; authentication and user state stay in their existing stores. The managed-account rollout remains disabled until the platform scope checks described below pass.

The startup migration adds the control schema and small columns/indexes to the old tables. It does not drop tables or move the owner's files. Keep a database backup before major migrations. Older HTML reports in `reports/` describe earlier versions; this README describes the current code.

Run `npm run check` and `scripts/test-postgres.sh`. The latter uses an isolated local PostgreSQL cluster, never the live database. Tests cover cross-user routing and approval attacks, duplicate intake, global capacity races, tenant and gateway locks, idle and login guards, preserved history, lost create replies and refusing deletion of a mismatched volume.

On 2026-09-22, `scripts/live-lifecycle.mjs` also verified real Sandboxes creation, browser launch, deletion, recreation on the same disk, and preservation of a file and browser localStorage. It removed both of its test sandboxes and its disposable volume. The owner environment was not deleted. This test did not make a model call or test two human Telegram accounts. Running it again creates billable test resources, then deletes only those resources. Do not send fake Telegram user updates to a live gateway as a test.

A separate live check on 2026-09-22 used the installed Codex 0.155.1 protocol: `thread/start.sandbox` uses kebab-case values such as `workspace-write` and `danger-full-access`. An ephemeral thread with that setting completed a real model turn and returned `Connection OK.` without tools. Check the installed schema when upgrading Codex; current online examples may use values from a different release.

On 2026-09-23, the persistence check verified all three CLI paths under `/workspace/.tools` with unchanged file timestamps after sandbox replacement, no browser downloads during restore, and working browser localStorage. The first persistence implementation took 45.3 seconds for a clean install and 14.3 seconds to restore; its repeated setup and SDK calls still delayed startup. The saved tool files used 649 MiB. The test removed its two sandboxes and disposable volume.

The follow-up optimization on 2026-09-23 reduced full cached runtime startup to 1.683 seconds, measured from the deployed worker: 184 ms reading the volume attachment, 790 ms creating the sandbox, and 403 ms restoring local files and starting Codex; the remaining time was SDK transport and bookkeeping. It uses one volume read, one create, and one exec request. Separate raw create requests measured 632–659 ms after the first allocation. These are single-run observations, not a sub-second guarantee. First-time installation still took 40.6 seconds. The lifecycle test again checked all CLI file timestamps, browser state, and user files and removed its test resources. Runtime metrics exclude Telegram delivery, resuming the selected topic, and model response time. Scheduler and tenant loop waits are now 200 ms instead of 2 seconds and 1.5 seconds.

## Telegram reply UX

Model replies use Telegram rich messages, with native Markdown headings, tables, lists, checklists, quotes, links, math and copyable code. The controller instructions describe the supported format. Text over 30,000 UTF-16 units is split conservatively; a definite rich-format rejection falls back to the existing text/entity renderer. Network failures do not trigger a second send through the fallback.

Substantive replies highlight the key result and important numbers, with sections, lists or comparison tables where useful. Short conversational replies stay simple. Completed replies can link to files inside their session directory; the bot sends these as Telegram documents in the same topic. Supported deliverables include PDF, office documents, images, text, HTML and ZIP, up to 20 MB each and ten files per reply. External web links stay links. Cross-session paths, hidden directories and symlinks outside the session are rejected. Binary uploads pass through a durable PostgreSQL queue; after Telegram confirms delivery, the queue keeps its file ID and releases the temporary bytes. Original files remain on the user's volume.

The bridge coalesces `item/agentMessage/delta` in memory, with a bounded preview per item. It returns live snapshots with its event batch; complete messages still use the durable event journal and outbox. Reasoning and command-output deltas never appear in Telegram previews. The worker edits one saved message per streamed item, reusing the startup message when present. The final reply updates that same message. Message IDs survive worker restarts. Telegram rate limits delay previews without holding up task processing. A typing heartbeat runs every four seconds while work is pending or active, and stops while a question awaits an answer.

Native `request_user_input` works in default mode through the installed Codex feature flag. New threads also receive a `telegram_ask_user` dynamic tool. Both show one question at a time, with native rich buttons, option descriptions, and a custom text answer. Answers persist in that user's PostgreSQL schema. A click must match the user, topic, bridge generation, pending request and current question. Old or duplicate buttons cannot submit another answer. A plain message or voice transcript in the topic answers its pending question. `/answer` remains as a legacy fallback for native questions.

Each streamed item keeps a stored identity. Previews edit the same Telegram message instead of replacing drafts, avoiding flicker and character animation. Its Stop button maps to the active turn. Only complete words enter previews, at most once every 150 ms. Final replies include all remaining text. The gateway checks for edits every 50 ms, coalesces previews to the newest version and honors Telegram’s retry_after per chat. Slow chats do not hold up others. These intervals exclude network and model latency. Read-only event polls use one SDK exec request, without a separate file upload. The Stop button can interrupt only its matching current turn. Legacy native Stop actions remain supported. Old IDs, other topics and other users are rejected. Control actions still work when the normal task queue is full. Bridge upgrades wait until active turns and pending requests finish; they preserve workspace files and saved threads.

On 2026-09-23, live Telegram checks accepted streamed rich drafts, a final Markdown message and a block-based message containing a heading, rich text and embedded buttons in the owner's `UX preview` topic. An isolated real Codex protocol check verified dynamic-tool registration without a model call. Automated tests cover fallback, throttling, durable clarification answers, repeated clicks, cross-user/topic isolation, final-message deduplication and native Stop routing.

### Settings Mini App

The chat's **Settings** menu button and `/settings` open a private Mini App. Users can edit or import their global AGENTS.md, choose a default model and reasoning effort, set reply language, toggle streaming, and shorten the idle timeout. Full access and installed tools remain the defaults. `/model default` returns a topic to the personal model default.

The gateway serves `/settings` and `/api/settings` on port 3000. Deploy `bot` with `lizard up --service bot --port 3000`; keep `worker` on port 0. The menu URL uses `TELEGRAM_MINI_APP_URL`, or `https://${LIZARD_PUBLIC_DOMAIN}/settings`. All interface text stays in English; the reply-language preference controls model replies.

Every API request verifies Telegram Mini App initData with HMAC, a one-hour maximum age and the signed user ID. Only approved users can read or change their own settings. Optimistic versions reject stale saves. The endpoint returns no account credentials, internal IDs or other users' data. Settings live in Managed Postgres; opening and saving the Mini App does not wake compute. Workers cache each user's available Codex models when connecting, without blocking startup.

Changes apply on the next task. A worker updates developer instructions for existing threads, and mirrors AGENTS.md into `/workspace/.telegram-codex/codex/AGENTS.md` when the environment next runs. It preserves an existing global file as `AGENTS.md.before-miniapp` before the first replacement. Project instructions remain separate. Settings survive idle deletion through the database and Persistent Volumes. Idle time cannot exceed the operator's configured limit.

Tests cover signed identity, expiry, tampering, admission, tenant isolation, save conflicts, size and resource limits, menu routing without starting compute, and application of instructions/model/effort to Codex turns. Native Mini App rendering still depends on the user's Telegram client.

### Apps gallery

The Mini App's Apps tab shows one card per published project: a human name, optional short description, a plain status and Open. It omits infrastructure, IDs, ports and account credentials. With managed accounts enabled, the worker lists apps using the user's workspace-scoped key and checks both workspace and project IDs. It prefers the project's website over internal services and hides the reserved `agent-state` project. The operator's broad provisioning key never enters a user's Sandbox.

Opening Apps reads a private cached list without starting compute. Refresh queues one background update; managed accounts do not need a running Sandbox. Completed tasks also refresh the list in the background, at most once per minute. Partial failures keep cached entries. Managed scans cover up to 200 projects per update with four concurrent reads; the UI marks incomplete results. With managed accounts disabled, the legacy collector still uses the user's own CLI login inside their Sandbox.

Codex gets instructions to maintain `/workspace/.telegram-codex/apps.json` with `{url,name,description}` after a successful publish. This supplies friendly labels for the gallery. Metadata can only label apps actually found in the user's account. The collector strips credentials and infrastructure fields before data leaves the Sandbox, and the controller validates the safe public URL again.

### Mini App navigation

The bottom bar has three tabs: **Apps**, **Settings**, and **Data**. Apps shows the user's published apps; Settings contains response defaults, AGENTS.md, and workspace preferences; Data shows saved chats, workspace state, and a way to copy saved instructions. `GET /api/data` reads only the signed-in user's schema, returns at most 40 recent chat titles, and never wakes compute. It does not expose paths, credentials, or internal IDs.

The UI follows `lizard-build/lizard-client/DESIGN.md`: local Geist fonts, the locked dark palette, emerald buttons, subtle card borders, status badges, and the tab picker active state. Controls use 44px touch targets and 16px input text for phones. Telegram 7.7+ vertical swipe dismissal is disabled; the content scrolls separately from the bottom bar. Viewport settings and touch handling prevent accidental zoom while keeping single-finger scrolling and text selection. Older Telegram clients may still allow swipe dismissal. Saved settings survive tab switches, and the save bar stays visible until changes are saved.

Topic names come from the first non-command user message only. The bot records that message before voice transcription or sign-in checks. Later messages and worker restarts cannot rename the topic, and existing topics keep their names when this rule is installed. Manual renames take priority.

Tasks show “Thinking…” while starting and before the first model reply. Private chats use Telegram’s native thinking draft, with one stable ID refreshed every 20 seconds. Groups use a saved message because Telegram only supports drafts in private chats. If a status message already exists, the bot edits it instead of adding a draft. The first response clears the private draft or edits the group placeholder; subsequent words and the final answer edit the same reply. Questions, stopped tasks, errors and interrupted recovery end the thinking state. The indicator contains no model reasoning. `/stop` remains available before the first words; streamed replies include their own Stop button.

Postgres keeps the message IDs and pending revisions so edits survive worker restarts and in-flight edits cannot discard the final answer. Later model messages remain separate. Long replies can span several Telegram messages. Unsupported native drafts fall back to a saved placeholder; rate limits and uncertain network sends do not trigger duplicate-message fallbacks.

GitHub CLI credentials persist in `/workspace/.config/gh`. Setup links the default `~/.config/gh` there on both fresh and cached starts. A one-time migration keeps the newer login when both paths contain credentials and backs up the replaced file on the same user’s volume. Each user still signs in to their own GitHub account; sessions within that user share the login.


### Managed publishing workspaces

With `LIZARD_MANAGED_ACCOUNTS=true` on the worker, approving a Telegram user creates one workspace and one workspace-scoped API key. Registration still requires approval or an invitation. A database lock serializes setup per user. Saved resource IDs and reconciliation by name prevent duplicates after a lost response. The worker checks the key's actual scope before installing it. Blocking a user revokes their managed key without deleting their saved files or apps.

With a worker-only `LIZARD_PROVISIONER_KEY`, approved users can get their own workspace and `agent-state` project on their first Codex command even when `LIZARD_MANAGED_ACCOUNTS=false`. This path creates no user API key and installs no platform credential inside the Sandbox. The flag controls automatic deployment login; it must not block ChatGPT sign-in or isolated compute. `/start`, `/help`, `/new` and `/sessions` work without workspace setup. Failed setup keeps the original request queued, shows a retry notice and allows those commands to respond.

Each workspace contains:

- `agent-state`: the user's Sandbox and Persistent Volume, including files, Codex history and login, GitHub login, tools, browser state and app labels.
- One project per app: the app's services and its databases. Agent instructions require a new app directory and project for each distinct app, and reuse that project for later updates. This is an agent convention, not an API restriction on how many services a project can contain.

The bot's gateway, worker and shared Managed Postgres stay in the operator's service project. Postgres holds admission, queues, settings and per-user tables. Each user's workspace holds their compute and disk state; idle cleanup removes compute only. Published apps have their own lifecycle.

The platform must reject scoped keys on account API key management routes. The bot probes this and access to its own project before issuing a key; it fails closed if either check succeeds. This requires the API hardening in `dragonlabs-platform` PR #54.

Set `LIZARD_PROVISIONER_KEY` and `TENANT_CREDENTIAL_KEY` on the worker only. The former must create workspaces and scoped keys; the latter is a stable random 32-byte base64 key. AES-256-GCM binds each stored credential to the bot project, Telegram user and workspace. Do not rotate the encryption key without re-encrypting stored credentials. Back it up separately from the database.

The scoped CLI login lives at `/workspace/.telegram-codex/lizard-cli/.lizard/config.json` with mode 0600. Its wrapper sets `LIZARD_HOME` and ignores old shell token variables. It preserves app project links. Setup restores the wrapper and login after Sandbox replacement. Users do not need to connect a separate Lizard account. Their full-access agent can read its own scoped key; it cannot use that key to access another user's workspace or the bot's project.

For existing users, deploy migration support with managed accounts disabled, then run `node scripts/migrate-tenant.mjs USER_ID` on the worker. The script pauses new work, takes the tenant lock and refuses to copy during a task or sign-in. It streams an authenticated archive into a new volume in `agent-state`, verifies the archive hash and switches project IDs in one database transaction. Each attempt uses a distinct transfer ID. Original volumes remain as backups. If verification fails, the original volume remains authoritative. Enable managed accounts after the existing users have migrated. A stuck migration keeps `migrating=true`; inspect the copy before clearing it.
