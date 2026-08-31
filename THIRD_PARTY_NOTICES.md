# Third-party notices

## Optional Meridian integration

The optional `deploy/agent-sdk` image installs `@rynfar/meridian` version
1.65.0 from npm during a local image build. LLM Gateway does not vendor or
modify Meridian source code.

The reviewed Meridian `package.json` and README declare the project to be MIT
licensed. At reviewed commit
`a53e83e65c9f0b5cdb5559b4996341c9f1795f52`, the repository did not contain a
standalone license file. Operators should verify upstream licensing before
redistributing an image containing that package.

## opencode-with-claude

`opencode-with-claude` was used as an architectural reference only. No source
code is included. Its reviewed repository contains an MIT license.
