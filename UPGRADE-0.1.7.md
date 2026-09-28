# Migrate QQ sessions and transport to native DSH APIs

Target: DSH `0.1.7-rc.2`, official Node `24.21.0`. Local branch:
`upgrade/dsh-0.1.7-rc.2`.

Replace removed ApiProxy and event access with session controllers, query/projections and V4 fork seeds. Preserve cross-client session selection, tool result presentation and transient streamed replies.

## Validation

Build and 51 local tests pass; production gateway reports ready. The user will test actual QQ send/receive. No proactive QQ acceptance message was sent.

Full deployment, patch sources and rollback record live in the companion
private upgrade workspace. No API keys, login
tokens, conversation logs or memory records are part of this source commit.
