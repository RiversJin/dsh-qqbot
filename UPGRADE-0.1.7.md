# Migrate QQ sessions and transport to native DSH APIs

Target: DSH `0.1.7-rc.2`, official Node `24.21.0`. Local branch:
`upgrade/dsh-0.1.7-rc.2`.

Replace removed ApiProxy and event access with session controllers, query/projections and V4 fork seeds. Preserve cross-client session selection, tool result presentation and transient streamed replies.

## Validation

Build and 51 local tests pass; production gateway reports ready. The user will test actual QQ send/receive. No proactive QQ acceptance message was sent.

Full deployment, patch sources and rollback record live in the companion
private upgrade workspace. No API keys, login
tokens, conversation logs or memory records are part of this source commit.

## QQ native retry follow-up

Version `0.4.1-rivers.8` adds `/retry` and retains `/bot-retry` and
`/bot-regenerate` as aliases. All three invoke the shared `dsh-retry >= 0.2.0`
command through the host registry on the same agent. The original request,
attachments and tools are replayed without an extra model instruction or fork.
Legacy `force` spellings are accepted without changing behavior. Commands restore
idle-evicted sessions and refresh the QQ reply target before generating.

Build and 52 tests pass. The companion `scripts/qq-retry-smoke.mjs` exercises the
real QQ command, session manager, outbound bridge and native loop with a local
fake adapter: all three aliases, four tool executions, unchanged session ID,
attachment replay, current reply targets, and strict V4 cold replay pass. No QQ
gateway or external model is used; actual QQ send/receive remains user-tested.
The npm lockfile was also brought in sync with the already-upgraded DSH peers.
