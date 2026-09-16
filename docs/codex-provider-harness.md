# Codex harness compatibility

Synthetic model catalog entries provide gateway-owned, provider-neutral workflow
instructions and select `code_mode_only` for the Anthropic, Antigravity, and xAI
adapters. Native OpenAI catalog entries retain their upstream instructions and
capabilities. The generic prompt preserves the model's actual identity and does
not copy an OpenAI model personality. It is supplied through both the current
`model_messages.instructions_template` field and the legacy `base_instructions`
field. This is client harness guidance, not an override of provider identity or
an instruction injected into every ordinary Messages request.

Code mode executes scripts in the Codex client. The gateway translates freeform
script calls to provider-compatible tool arguments and restores their original
names, namespaces, call IDs, and raw script input on return. The gateway and
Agent SDK bridge do not execute the client's MCP tools or JavaScript. Client
approvals, sandboxing, MCP authentication, and tool permissions still apply.
Clients must support and enable code mode; the catalog alone cannot enable a
disabled client feature. Codex CLI 0.153.4 can enable it with `--enable code_mode`.

Before reporting an integration unavailable, the generic instructions direct
models to inspect deferred tools using the supplied code-mode catalog or tool
search. MCP resources are not a substitute for MCP tool discovery.

## Tool search and text phases

The Anthropic translator preserves client-executed `tool_search` definitions,
restores `tool_search_call` output, loads definitions from `tool_search_output`,
and replays the paired search call and result. This also covers Antigravity and
both direct Anthropic and Agent SDK transports because they share this
translator. Server-executed tool search is rejected rather than silently
discarded. xAI's Responses compatibility path retains its existing search wire.

Anthropic-style text streams immediately. Message finalization waits until a
following tool call or the provider's stop reason is known. Text before tools
is finalized with `phase: commentary`; the last pending text message on
`end_turn` receives `phase: final_answer`. Truncated output is not mislabeled as
a final answer. The phase is supplied on `response.output_item.done`, not guessed
when the first token arrives. This is a compatibility mapping, not a claim that
these providers expose OpenAI's native channel protocol. Native Responses
provider phases remain untouched.

## Verification on 2026-09-10

- Full unit suite and disposable PostgreSQL integration suite passed; all 269
  gateway tests ran without skips in the database run. Type checking, lint,
  Prisma validation, changed-file formatting, and the container build passed.
- Live synthetic Responses script loops passed through Claude Haiku over Agent
  SDK and Gemini Flash over direct Antigravity, including commentary and final
  phases. Their ordinary Messages tool loops also passed.
- Live Claude client tool search completed discovery, invocation of the loaded
  tool, and a final response.
- Codex CLI 0.153.4 discovered and invoked a synthetic MCP with both providers.
  A structural request check confirmed generic instructions, `exec`/`wait`
  tools, and custom script-call history reached the gateway for Claude.
- Direct Anthropic and xAI compatibility are covered by fixtures; no direct
  Anthropic account or xAI account was configured for those live checks. These
  tests do not establish identical behavior across every model or replace a
  check in a fresh Desktop task with the user's actual MCP configuration.

Use a fresh task after the client refreshes its model catalog. Existing tasks
may retain the earlier instructions and tool surface. Do not work around stale
metadata by borrowing an OpenAI model's identity or replacing MCP credentials.

## Cross-provider subagents

The live spawn catalog is supplied at request dispatch in the model instructions,
the spawn tool description, and its containing namespace description. It
replaces Codex's abbreviated model preview without removing fork or permission
rules. It also covers deferred collaboration tools. Repeated requests refresh
the same catalog section rather than accumulating copies; a narrower client
key removes models that are no longer allowed. No bundled model roster is used.

Native OpenAI collaboration calls can carry provider-encrypted task arguments.
Those messages cannot be interpreted by another provider. On the OpenAI
Responses wire, the gateway exposes delegation tools as ordinary function
aliases and removes the provider-specific `encrypted` message-schema flag.
Both are needed: native reserved tools require encryption, and aliases with
the encryption flag still produce opaque tasks. On return the gateway restores
the original name and namespace and declares `encrypted_function_args: []`.
Arguments and call IDs remain unchanged; plaintext call history is mapped back
to the aliases, while older encrypted native calls retain their identity.
Explicit encrypted output from a plaintext alias fails closed.
Grok's ordinary collaboration arguments receive a plaintext declaration too;
explicit existing encryption metadata is preserved.

This is a transport compatibility boundary. Tasks still execute in the Codex
client with its normal approvals, model eligibility, and concurrency limits.
Full-history forks still inherit their parent's model when required by Codex;
an explicit cross-model choice must use an allowed fresh or partial fork.

Adversarial review for this transport change checks that aliases cannot collide
with caller tools, only declared collaboration message schemas are changed,
explicit encrypted output fails closed, and historical encrypted payloads are
not relabeled or decrypted. The catalog remains live and key-scoped; no routing
authorization, client permissions, credential storage, or logging boundary is
relaxed. Fixtures cover these cases and preserve unrelated instructions,
schemas, and argument values.

Verification on 2026-09-11: all 277 gateway tests passed in the disposable
PostgreSQL run, with the unit suite, type checking, lint, schema validation,
formatting, and container build also passing. Live synthetic tests covered
Claude Opus to Claude Haiku, Gemini, and GPT; Gemini to Claude and GPT; GPT Sol
to Claude and Gemini; and the V1 GPT Luna path to Claude. Checks verified the
requested child models and readable task text on their first requests, followed
by completion. On the Mac's configured local proxy, both the CLI binary and
Desktop-bundled Codex engine listed all 24 current model IDs; actual cross-provider
spawns passed too. These were isolated ephemeral client runs, not an automated
UI interaction with existing Desktop tasks. No xAI account was available for a
live test; its plaintext declaration is fixture-covered.
