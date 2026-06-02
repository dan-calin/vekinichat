import { defineConfig } from 'vite';

export default defineConfig({
    // Host must be set to 0.0.0.0 for Tauri to be able to reach the dev server
    server: {
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
    },

    build: {
        // Suppress the 500 kB chunk size warning — livekit-client alone exceeds it
        chunkSizeWarningLimit: 2000,

        rollupOptions: {
            output: {
                // Split large vendor libraries into their own cached chunks.
                // This means the browser only re-downloads livekit when the package
                // version changes, not every time the app code changes.
                manualChunks: {
                    'livekit': ['livekit-client'],
                    'supabase': ['@supabase/supabase-js'],
                },
            },
        },
    },
});
