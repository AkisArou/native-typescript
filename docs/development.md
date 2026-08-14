# Development

## Prerequisites

The repository pins Node.js in `.tool-versions` and pnpm in `package.json`.
Enable Corepack once for the selected Node installation, then initialize the
workspace:

```bash
corepack enable pnpm
git submodule update --init --recursive
pnpm install --frozen-lockfile
```

The parent pnpm workspace intentionally excludes `third_party/scriptc`.
Install its dependencies separately:

```bash
pnpm scriptc:install
```

## Workspace commands

```bash
pnpm build
pnpm test
pnpm native-typescript --help
pnpm native-typescript doctor
```

Node runs the workspace's `.ts` source directly through built-in type
stripping. During development, run execution and type checking in separate
terminals:

```bash
pnpm dev
pnpm build:watch
```

Source executed by Node must use erasable TypeScript syntax. Use explicit
`.ts` extensions for relative imports and `import type` for type-only imports.

## Updating scriptc

The fork keeps `main` as an unmodified mirror of `vercel-labs/scriptc`. Project
changes live on `native-typescript`, which is the branch pinned by the
submodule.

Configure the upstream remote once per submodule clone:

```bash
git -C third_party/scriptc remote add upstream https://github.com/vercel-labs/scriptc.git
```

To incorporate upstream work:

```bash
git -C third_party/scriptc fetch upstream main
git -C third_party/scriptc push origin upstream/main:main
git -C third_party/scriptc switch native-typescript
git -C third_party/scriptc merge upstream/main
pnpm scriptc:install
pnpm scriptc:build
pnpm scriptc:test
git -C third_party/scriptc push origin native-typescript
git add third_party/scriptc
```

Resolve merge conflicts inside the submodule before running validation. The
parent repository records an exact scriptc commit, so commit and push the
updated gitlink only after the fork branch is validated and pushed.

