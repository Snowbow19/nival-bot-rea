# Native UI contracts (Grok Bot 0.70.2 extracted bundle)

## Context / Object
Context: existing extracted renderer and local bridge; cloud computer excluded. Object: local Bot resource and execution UI. Contracts below come from source inspection, not runtime UI acceptance. Offsets are zero-based JavaScript string offsets in minified originals; search the named function to recover the exact section. No credentials inspected.

## Attributes

### Skills / Workflows
`extracted/dist/electron-main/main-app.cjs` offset 960917 (qKt/kFe): input spec strictly requires `name:string`, `description:string`, `body:string`, `trigger:null | {schedule:string,isEnabled:boolean}`; optional `sourceRef:string|null`.
`extracted/dist/renderer/assets/chunk-view-DHaP6CKF.js` offset 115399: editor passes exactly `{name,description,body,trigger,sourceRef}` to update. Do not substitute `content` for `body` on this legacy coordinator endpoint.
`extracted/dist/renderer/assets/index.eager-app-fbmFpqqH.js` function f2e offset 1226270: get/create/update/delete all return the complete workflow array. create args `{id:agentId,spec}`, update `{id:agentId,workflowId,spec}`, delete `{id:agentId,workflowId}`, run `{id:agentId,workflowId}`. Import returns `{workflows,result}`.

Minimal local row compatible with the observed editor:
```json
{"id":"skill-1","name":"总结讨论","description":"总结群聊结论","body":"总结结论、分歧和下一步行动。","trigger":null,"sourceRef":null,"createdAt":1791849600000}
```
Additional modern native skill endpoint is separate: `addGrokBotAgentSkill({agentId,name?,description?,content,files?})`, `updateGrokBotAgentSkill({agentId,name,description?,content,files?})`, `removeGrokBotAgentSkill({agentId,name})` (eager renderer offset 490500). Do not assume both stores are automatically synchronized.

### Tasks
`extracted/dist/electron-main/main-app.cjs` offset 2281090 maps server tasks into exactly this shape:
```json
{"id":"task-1","name":"讨论计划","description":"产出行动清单","status":"open","updatedAtMs":1791849600000}
```
Optional `unreadEntryId:string`, `unreadPreview:string`, `unreadAtMs:number` (epoch milliseconds). `getAgentTasks` takes `{agentId}`, unlike workflow/automation get's `{id}`. Mutations `markAgentTaskDone({agentId,taskId})` and `markAgentTaskRead({agentId,taskId,entryId})` return complete array.

### Automations
`extracted/dist/electron-main/main-app.cjs` function Upn offset 2255640 requires: `id,name,prompt,schedule,triggerDescription,filePath` strings; `trigger` object; `isEnabled` boolean; `createdAt` number; `runs` array. Optional nextRunAt number used for sorting. These are display records, not merely creation specs.
`extracted/dist/renderer/assets/chunk-automation-detail-panel-CQ-QyTRY.js` offset 11438 dereferences `s.runs[0]?.status`; missing `runs` will throw. Existing bridge creates incomplete records.
The observed shallow validator accepts this inactive example (scheduling grammar still requires implementation-specific validation):
```json
{"id":"routine-1","name":"每日总结","prompt":"总结今天的讨论","trigger":{"type":"schedule"},"schedule":"0 18 * * *","triggerDescription":"每天 18:00","isEnabled":false,"createdAt":1791849600000,"filePath":"routines/routine-1.md","runs":[]}
```
`trigger.type === "group"` requires `listeners` array (Wg eager renderer offset 208940). For a manual run the view searches a run with `trigger === "manual"`, uses its `id`, and regards `status === "running"` as busy. Full run schema was not established in this inspection; do not fabricate successful runs.

### Bot files (native bot overview)
`extracted/dist/electron-main/main-app.cjs` functions C9e/I9e offset 2083900: list returns an object, not an array:
```json
{"files":[{"name":"notes.md","path":"files/notes.md","sizeBytes":12,"contentType":"text/markdown","updatedAtMs":1791849600000,"etag":"local-version-1"}],"totalBytes":12,"canEdit":true}
```
`listGrokBotAgentFiles({agentId})`; upload `{agentId,fileName,contentType,bytes:Uint8Array}` returns one file row; delete `{agentId,name}` returns void. Eager renderer bAe offset 1258050 wraps the result in `[result]` internally and refreshes after upload/delete.
`chunk-team-bot-overview-panel-CZp57N2e.js` offset 2500 validates max 25 MiB per file, 200 files, total 1 GiB; zero-length files rejected. Preserve bounds or consciously document a changed local implementation.

### Library pages/documents
Native wrappers at eager renderer offsets 1696028–1696300 call `listLibraryPages({includeDocuments})`, `listLibraryDocs({agentId})`, and `resolveLibraryPages({refs,includeDocuments})`.
`listLibraryPages` must return an object with `pages` array (eager renderer offset 296900); entries have `title`, `visibility`, and `kind`; canvas branches are discriminated by `kind === "canvas"`. Document lookup uses `storeId` + `documentId` keys (sS offset 287480). This is distinct from Bot uploaded files. Full page/document union was not established; implementing uploaded Bot files first is supported by stronger contract evidence.

## States
Tasks are mutually exclusive `open` or `done`. Renderer NU (eager offset 410500) keeps all open tasks, but only done tasks updated within 4320 minutes (3 days), with seen completed rows retained in local snapshots. Unread thread badges require open status plus unreadEntryId. markRead removes unreadEntryId/unreadPreview/unreadAtMs only when entryId matches. markDone closes the task thread.
Automations have an independent enabled boolean and execution status; enabling does not imply a run occurred. View disables run during running. Skills with trigger null are unscheduled. File state is persisted metadata plus actual bytes; listing alone does not prove model access.

## Behaviors / execution effects
Workflow create/update/delete must persist then return the complete per-agent array. Task mutations must persist then return complete per-agent array. Automation enabled/update/delete must return complete array. A model-created entity must refresh corresponding resource state rather than merely append prose.

### Can tool results use native send-message cards?
Native supported send-message types are enumerated in eager renderer `Pfe` offset 985320: text, attachment, widget, cursor-agent, secret-request, credential-request, user-form, email-draft, slack-draft, meeting-chat-draft, calendar-event, permission-request, connector, connectors, listener-connect, scm-connect, onepassword-connect, team-access, slack-connect, bot-template-share, auto-review-approval, connector-grant, local-tool-permission, virtual-card-approval, cookie-origin-approval, publish-approval, mobile-tool-permission.
There is **no generic tool-result / tool-status send-message card**. A separate `kind:"tool-call"` exists, but `Ofe()` returns null for it (offset 986355), so it is not a normal supported conversation tile. The canonical entity operation result can use existing `send-message` text, plus actual refreshed entity UI:
```json
{"id":"result-1","kind":"send-message","timestampMs":1791849600000,"message":{"type":"text","content":"已创建群聊「产品讨论」，成员：产品经理、工程师。"}}
```
Only emit success after storage/mutation succeeds. For richer cards use an already-supported semantic card with its full schema; do not relabel generic tool output as e.g. cursor-agent. A generic new card requires deliberate renderer extension.
