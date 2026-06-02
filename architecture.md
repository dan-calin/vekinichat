# VekiniChat Architecture Overview

## 1. Current Architecture
VekiniChat is built as a hybrid Web / Desktop application utilizing a Vanilla Javascript front-end, a Supabase backend, and LiveKit for WebRTC voice/video functionality.

### Tech Stack
- **Frontend Core**: HTML5, Vanilla CSS3 (with CSS variables for theming), Vanilla JavaScript (ES Modules).
- **Bundler**: Vite.
- **Desktop Packaging**: Tauri (`@tauri-apps/cli`, `@tauri-apps/api`).
- **Backend / Database**: Supabase (PostgreSQL, Auth, Realtime, Edge Functions).
- **Communication (Voice/Video)**: LiveKit (`livekit-client`).

### Application Structure
- `index.html`: The main entry point containing the entire DOM structure. It holds the auth views, the main app layout, and all modal dialogs.
- `src/main.js`: A large monolithic controller (~3300 lines) that handles DOM querying, event binding, state management, real-time events, Tauri window management, and business logic.
- `src/style.css`: Contains all application styles, relying heavily on modern CSS variables, flexbox, and glassmorphism UI patterns.
- `src/supabase.js`: Initializes the Supabase client.
- `src/auth.js`: A clean wrapper around Supabase authentication methods.
- `src/voice.js`: Manages the LiveKit WebRTC connection, room events, microphone/screen-share streaming, and LiveKit access token fetching via an authenticated Supabase Edge Function (`/functions/v1/livekit-token`).

---

## 2. Identified Problems & Mistakes

### Security & Configuration Management
- **Hardcoded Secrets**: `SUPABASE_URL` and `SUPABASE_ANON_KEY` are hardcoded in **both** `src/supabase.js` and `src/voice.js`. While Supabase Anon keys are meant to be public-facing (relying on Row Level Security), they should still be managed via environment variables (e.g., `import.meta.env.VITE_SUPABASE_URL`) to allow seamless switching between development, staging, and production environments without modifying committed code.
- **Code Duplication**: The Supabase URL and Key are duplicated across two separate configuration/integration files.

### Maintainability & Code Organization
- **Monolithic `main.js`**: `src/main.js` is extremely large. It heavily mixes DOM querying/manipulation, explicit state management (`let currentUser`, `let servers`, `let channels`), fetching logic, and Supabase real-time subscription handling. This makes it extremely hard to read, maintain, and debug.
- **Manual DOM Updates**: UI updates are done imperatively through `container.innerHTML` and manual DOM element creation (`document.createElement`). This approach is highly prone to bugs, makes it difficult to maintain event listeners securely, and can lead to memory leaks if old event listeners on discarded DOM nodes aren't correctly managed.

---

## 3. Recommended Improvements

### Short-Term (Quick Wins)
1. **Environment Variables**: Move the Supabase URL and Anon Key into a `.env` file at the project root. Access them via Vite's `import.meta.env` infrastructure.
2. **Remove Duplication**: Update `supabase.js` to utilize the environment variables, and update `voice.js` to either import these configuration variables from `supabase.js` or directly from `import.meta.env`.

### Medium-Term (Refactoring)
3. **Modularize `main.js`**: Split the single monolithic file into logical domains:
   - **State Management**: Create a `state.js` file to hold global properties (`currentUser`, `activeServer`, `activeChannel`) and export accessors/setters.
   - **UI Components**: Isolate the rendering logic into specialized files like `renderSidebar.js`, `renderChat.js`, `renderVoice.js`, and `modalControllers.js`.
   - **Business Logic**: Separate Supabase database calls (fetching servers, fetching channels, sending messages) into an independent service module (e.g., `api.js` or `services.js`).
4. **Utilize HTML `<template>` Elements**: Instead of executing large HTML string interpolations (`container.innerHTML = ...`), adopt the `<template>` element in `index.html`. You can clone these templates in JavaScript securely, which maintains better separation of markup and scripting.

### Long-Term (Architectural Shift)
5. **Adopt a Lightweight Framework**: For a real-time application of this complexity—handling persistent WebSocket connections, complex client-side state, deeply nested UI (Servers -> Channels -> Messages), and real-time UI reactions—Vanilla JS becomes inherently unmanageable. Replacing manual DOM manipulation with a reactive framework (like **React**, **Vue**, or **Svelte**) would drastically reduce overhead, prevent DOM-syncing bugs, and provide a superior developer experience.