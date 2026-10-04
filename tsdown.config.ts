/**
 * Build config for dsh-lan-access.
 *
 * Two artifacts:
 * - lib/index.js   — the Host half (ESM, node): the /lan-access route, the
 *                    settings namespace, and the webserver rebind controller.
 * - lib/client.js  — the browser half (CJS closure-factory bundle): loaded as
 *                    a classic script, it registers itself via
 *                    window.__ModuleLoader__.load({ id, factory }), exactly
 *                    like the DSH monorepo's tsdown.client preset. Only the
 *                    frozen platform-module table words stay external; every
 *                    other import is inlined.
 */
import { defineConfig } from 'tsdown'

/** The shell's frozen platform-module table (single source in the monorepo:
 *  packages/client/web/src/platform.ts). These stay external: the browser
 *  require answered by the module table resolves them to shared instances. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** The client bundle's id (the graph row id == package name). */
const CLIENT_ID = 'dsh-lan-access'

export default defineConfig([
  {
    name: CLIENT_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: false,
    clean: true,
    fixedExtension: false,
    // Host-half runtime imports resolve from the profile's node_modules
    // (the DSH packages are peer deps); node: builtins stay automatic.
    // tsdown >=0.22 spells the former top-level `external` as deps.neverBundle.
    deps: {
      neverBundle: (id: string) => id.startsWith('@deepseek-ai/'),
    },
  },
  {
    name: CLIENT_ID + '/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Platform-table words stay external; everything else inlines.
    // tsdown >=0.22 spells `external`/`noExternal` as deps.neverBundle/deps.alwaysBundle.
    deps: {
      neverBundle: (id: string) => PLATFORM_MODULES.includes(id),
      alwaysBundle: (id: string) => !PLATFORM_MODULES.includes(id),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(CLIENT_ID) + ', factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
