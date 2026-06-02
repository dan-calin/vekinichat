// A tiny reactive store to keep track of global application state
// This uses mere bytes of memory compared to heavy state management libraries.

const listeners = [];

export const state = {
    currentUser: null,
    currentProfile: null,
    servers: [],
    activeServerId: null,
    channels: [],
    activeChannelId: null,
    messages: [],
    currentUserPermissionsCache: null,
};

/**
 * Subscribes to state changes.
 * @param {Function} callback - Called with (state, updates)
 * @returns {Function} Unsubscribe function
 */
export function subscribe(callback) {
    listeners.push(callback);
    return () => {
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
    };
}

/**
 * Patches the state with new values and notifies listeners.
 * @param {Object} updates - The partial state changes
 */
export function patchState(updates) {
    Object.assign(state, updates);
    listeners.forEach(fn => fn(state, updates));
}

/**
 * Getter for current state.
 */
export function getState() {
    return state;
}
