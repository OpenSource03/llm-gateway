# Third-party notices

## Optional Meridian integration

The optional `deploy/agent-sdk` image installs `@rynfar/meridian` version
1.66.0 from npm during a local image build. LLM Gateway does not vendor or
modify Meridian source code.

The reviewed Meridian `package.json` and README declare the project to be MIT
licensed. At reviewed commit
`1ea97d0122fdd106e9c1bf5c771efdb6d8a30f01`, the repository did not contain a
standalone license file. Operators should verify upstream licensing before
redistributing an image containing that package.

## opencode-with-claude

`opencode-with-claude` was used as an architectural reference only. No source
code is included. Its reviewed repository contains an MIT license.
