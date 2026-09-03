# Third-party notices

## Optional Meridian integration

The optional `deploy/agent-sdk` image installs `@rynfar/meridian` version
1.66.0 from npm during a local image build. LLM Gateway does not vendor its
source. The derived image applies the narrow, version-pinned transformation in
`deploy/agent-sdk/patches/preserve-cancelled-checkpoint.mjs`; the build fails if
the reviewed upstream bundle signatures change.

The reviewed Meridian `package.json` and README declare the project to be MIT
licensed. At reviewed commit
`1ea97d0122fdd106e9c1bf5c771efdb6d8a30f01`, the repository did not contain a
standalone license file. Operators should verify upstream licensing before
redistributing an image containing that package.

## opencode-with-claude

`opencode-with-claude` was used as an architectural reference only. No source
code is included. Its reviewed repository contains an MIT license.
