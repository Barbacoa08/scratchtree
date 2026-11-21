import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';

export default defineConfig(({ mode }) => {
  const publicWeb = mode === 'public-web';
  return {
    ...(publicWeb && {
      resolve: {
        alias: {
          '#workspace-entry': fileURLToPath(
            new URL(
              './src/lib/components/PublicWebWorkspace.svelte',
              import.meta.url,
            ),
          ),
          'dexie-cloud-addon': fileURLToPath(
            new URL(
              './src/lib/platform/browser-cloud-disabled.ts',
              import.meta.url,
            ),
          ),
        },
      },
    }),
    plugins: [
      sveltekit({
        adapter: adapter({
          fallback: 'index.html',
          pages: publicWeb ? 'public-web-dist' : 'build',
        }),
        prerender: { entries: [] },
        ...(publicWeb && {
          serviceWorker: { register: false },
          version: { name: 'public-web', pollInterval: 0 },
        }),
      }),
    ],
    server: { host: '127.0.0.1', port: 4511, strictPort: true },
  };
});
