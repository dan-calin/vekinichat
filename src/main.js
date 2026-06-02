import './style.css';
import { signOut, onAuthChange, getProfile } from './auth.js';
import { fetchUserServers, fetchServerChannels, fetchMemberPermissions } from './api.js';
import { setupAuthUI } from './ui/auth.js';
import { initSettingsModule, openServerSettingsModal, refreshVoiceSettings } from './ui/settings.js';
import { initSidebarModule, renderSidebar as _renderSidebar, renderChannels as _renderChannels, renderVoiceStatus as _renderVoiceStatus } from './ui/sidebar.js';
import { supabase } from './supabase.js';
import { Track } from 'livekit-client';
import {
  joinVoiceChannel, leaveVoiceChannel, toggleMute, isMuted,
  updateAudioOptions, getAudioDevices, setInputDevice, setOutputDevice,
  setDeafen, getIsDeafened, setParticipantVolume, setVoiceCallbacks,
  toggleScreenShare, getActiveRoom, notifyParticipants
} from './voice.js';
import { invoke } from '@tauri-apps/api/core';

// Tauri Window Management
let tauriWindow = null;
try {
  import('@tauri-apps/api/window').then(module => {
    tauriWindow = module.getCurrentWindow();

    // Wire up custom titlebar buttons
    const minBtn = document.getElementById('titlebar-minimize');
    const maxBtn = document.getElementById('titlebar-maximize');
    const closeBtn = document.getElementById('titlebar-close');

    if (minBtn) {
      minBtn.addEventListener('click', () => tauriWindow?.minimize());
    }
    if (maxBtn) {
      maxBtn.addEventListener('click', () => tauriWindow?.toggleMaximize());
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => tauriWindow?.close());
    }

    // Wire up physical resize handle
    const resizeHandle = document.getElementById('desktop-resize-handle');
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        tauriWindow?.startResizeDragging('SouthEast');
      });
    }
  }).catch(() => { /* Not running in Tauri */ });
} catch (e) {
  // Ignore
}




/* ============================================================
   DOM References
   ============================================================ */
const $ = (sel) => document.querySelector(sel);

const authView = $('#auth-view');
const appView = $('#app-view');
// Auth UI is now bound in setupAuthUI
const logoutBtn = $('#logout-btn');
const deafenBtn = $('#deafen-btn');
const sidebarMuteBtn = $('#sidebar-mute-btn');
const sidebarShareBtn = $('#sidebar-share-btn');
const userName = $('#user-name');
const userAvatar = $('#user-avatar');
const mainContent = $('#main-content');
const sidebarServers = $('#sidebar-servers');
const inviteBanner = $('#invite-banner');
const inviteCodeDisp = $('#invite-code-display');
const copyInviteBtn = $('#copy-invite-btn');
const sidebar = $('aside'); // Need sidebar reference for sticking voice bar

// Modals
const channelModalOverlay = $('#channel-modal-overlay');
const createChannelBtn = null; // No longer a static DOM element — created dynamically per server
const createChannelForm = $('#create-channel-form');
const channelModalCancel = $('#channel-modal-cancel');

const createServerModalOverlay = $('#create-server-modal-overlay');
const createServerBtn = $('#create-server-btn');
const createServerForm = $('#create-server-form');
const createServerCancel = $('#create-server-cancel');

const joinServerModalOverlay = $('#join-server-modal-overlay');
const joinServerBtn = $('#join-server-btn');
const joinServerForm = $('#join-server-form');
const joinServerCancel = $('#join-server-cancel');
const joinServerError = $('#join-server-error');

// Server Settings Modal
const serverSettingsModalOverlay = $('#server-settings-modal-overlay');
const serverSettingsClose = $('#server-settings-close');
const renameServerForm = $('#rename-server-form');
const renameServerInput = $('#rename-server-input');
const renameServerBtn = $('#rename-server-btn');
const memberManagementList = $('#member-management-list');
const deleteServerBtn = $('#delete-server-btn');
const deleteServerConfirmContainer = $('#delete-server-confirm-container');
const deleteServerConfirmInput = $('#delete-server-confirm-input');
const deleteServerConfirmBtn = $('#delete-server-confirm-btn');
const serverIconUploadInput = $('#server-icon-upload-input');
const serverSettingsIconPreview = $('#server-settings-icon-preview');

// Settings DOM
const inputDeviceSelect = $('#input-device-select');
const outputDeviceSelect = $('#output-device-select');
const avatarUploadInput = $('#avatar-upload-input');
const uploadAvatarBtn = $('#upload-avatar-btn');
const keybindList = $('#keybind-list');

/* ============================================================
   State
   ============================================================ */
let currentUser = null;
let currentProfile = null;
let servers = [];
let activeServerId = null;
let channels = [];
let activeChannelId = null;
let messages = [];
let currentUserPermissionsCache = null;

function hasPermission(flag) {
  if (!currentUserPermissionsCache) return false;
  if (currentUserPermissionsCache.isOwner) return true;
  return !!currentUserPermissionsCache[flag];
}

async function loadCurrentUserPermissions(serverId, ownerId) {
  currentUserPermissionsCache = { isOwner: (currentUser.id === ownerId) };
  if (currentUserPermissionsCache.isOwner) return;

  const permissions = await fetchMemberPermissions(serverId, currentUser.id);
  Object.assign(currentUserPermissionsCache, permissions);
}
let realtimeSub = null;          // Supabase Realtime subscription
let activeVoiceChannelId = null;
let presenceChannel = null;
let channelPresences = {};
let stagedAttachment = null;     // Holds the currently selected file for upload
const profileCache = new Map();  // uid → { username, avatar_url }
const participantVolumes = new Map(); // identity → volume (0-1)

/* ============================================================
   Initialize external UI components
   ============================================================ */
setupAuthUI();
initSidebarModule({
  get sidebarServers() { return sidebarServers; },
  get servers() { return servers; },
  get activeServerId() { return activeServerId; },
  set activeServerId(v) { activeServerId = v; },
  get activeChannelId() { return activeChannelId; },
  get channels() { return channels; },
  get channelPresences() { return channelPresences; },
  get activeVoiceChannelId() { return activeVoiceChannelId; },
  get currentUser() { return currentUser; },
  get channelModalOverlay() { return channelModalOverlay; },
  hasPermission,
  escapeHtml,
  selectServer,
  selectChannel,
  disconnectVoice,
  get openServerSettingsModal() { return openServerSettingsModal; },
});

/* ============================================================
   Custom Titlebar API wiring
   ============================================================ */
$('#titlebar-minimize')?.addEventListener('click', () => tauriWindow?.minimize());
$('#titlebar-maximize')?.addEventListener('click', async () => {
  if (tauriWindow) {
    if (await tauriWindow.isMaximized()) {
      await tauriWindow.unmaximize();
    } else {
      await tauriWindow.maximize();
    }
  }
});
$('#titlebar-close')?.addEventListener('click', () => tauriWindow?.close());
$('#auth-close')?.addEventListener('click', () => tauriWindow?.close());

/* ============================================================
   Form Submissions (Moved to setupAuthUI)
   ============================================================ */

/* ============================================================
   Auth Initialization — single sequential flow, no race conditions
   ============================================================ */
async function initAuth() {
  const { data: { session: existingSession } } = await supabase.auth.getSession();

  if (existingSession?.user) {
    const { data: { session: refreshed }, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshed?.user) {
      currentUser = refreshed.user;
      await enterApp();
    } else {
      console.warn('[Auth] Session refresh failed:', refreshError?.message);
      await supabase.auth.signOut();
    }
  }

  onAuthChange(async (event, session) => {
    if (event === 'SIGNED_IN') {
      if (currentUser?.id === session?.user?.id) return;
      currentUser = session.user;
      await enterApp();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      currentProfile = null;
      exitApp();
    }
  });
}

initAuth();

/* ============================================================
   App Entry / Exit
   ============================================================ */
async function enterApp() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  $('#custom-titlebar')?.classList.remove('hidden');

  const fallbackUsername = currentUser.user_metadata?.username || currentUser.email?.split('@')[0] || 'User';
  try {
    currentProfile = await getProfile(currentUser.id);
  } catch {
    const { data: newProfile } = await supabase
      .from('profiles')
      .upsert({ id: currentUser.id, username: fallbackUsername }, { onConflict: 'id' })
      .select()
      .single();
    currentProfile = newProfile || { username: fallbackUsername };
  }

  const displayName = currentProfile.username || 'User';
  userName.textContent = displayName;

  if (currentProfile.avatar_url) {
    userAvatar.style.backgroundImage = `url('${currentProfile.avatar_url}')`;
    userAvatar.textContent = '';
  } else {
    userAvatar.style.backgroundImage = 'none';
    userAvatar.textContent = displayName.charAt(0).toUpperCase();
  }

  await loadServers();
  initPresence();
}

function exitApp() {
  leaveVoiceChannel();
  appView.classList.add('hidden');
  authView.classList.remove('hidden');
  $('#custom-titlebar')?.classList.add('hidden');
  sidebarServers.innerHTML = '';
  activeServerId = null;
  activeChannelId = null;
}

/* ============================================================
   Logout
   ============================================================ */
logoutBtn.addEventListener('click', async () => {
  try { await signOut(); } catch (err) { console.error('Logout error:', err); }
});

/* ============================================================
   Servers — Load, Render (Accordion), Select
   ============================================================ */
async function loadServers() {
  try {
    servers = await fetchUserServers(currentUser.id);
  } catch (error) {
    return;
  }
  renderSidebar();

  if (servers.length > 0 && !activeServerId) {
    selectServer(servers[0].id);
  } else if (servers.length === 0) {
    activeServerId = null;
    inviteBanner.classList.add('hidden');
    mainContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🌐</div>
        <h2>No Servers</h2>
        <p>Create a server or join one with an invite code.</p>
      </div>
    `;
  }
}

function renderSidebar() {
  _renderSidebar();
}

async function selectServer(serverId) {
  await leaveVoiceChannel();

  activeServerId = serverId;
  activeChannelId = null;

  // Update accordion states
  document.querySelectorAll('.server-section').forEach((sec) => {
    const isActive = sec.dataset.serverId === serverId;
    sec.classList.toggle('expanded', isActive);
    sec.querySelector('.server-section-header').classList.toggle('active', isActive);
  });

  const srv = servers.find((s) => s.id === serverId);
  if (srv) {
    inviteBanner.classList.remove('hidden');
    inviteCodeDisp.textContent = srv.invite_code;
    await loadCurrentUserPermissions(serverId, srv.owner_id);
  } else {
    currentUserPermissionsCache = null;
  }

  // Re-render sidebar after permissions load so gear icon reflects the user's roles
  renderSidebar();

  await loadChannels();

  mainContent.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">💬</div>
      <h2>Welcome to ${escapeHtml(srv?.name || 'server')}</h2>
      <p>Select a channel to start chatting.</p>
    </div>
  `;
}

/* ============================================================
   Copy Invite Code
   ============================================================ */
copyInviteBtn.addEventListener('click', () => {
  const code = inviteCodeDisp.textContent;
  navigator.clipboard.writeText(code).then(() => {
    copyInviteBtn.title = 'Copied!';
    setTimeout(() => { copyInviteBtn.title = 'Copy'; }, 2000);
  });
});

/* ============================================================
   Channels — Load & Render (inside server accordion)
   ============================================================ */
async function loadChannels() {
  if (!activeServerId) {
    channels = [];
    return;
  }

  try {
    channels = await fetchServerChannels(activeServerId);
  } catch (error) {
    return;
  }
  renderChannels();
}

function renderChannels() {
  _renderChannels();
}


async function selectChannel(channelId) {
  if (realtimeSub) {
    supabase.removeChannel(realtimeSub);
    realtimeSub = null;
  }

  activeChannelId = channelId;
  messages = [];
  renderChannels();

  // Update Voice Status Bar
  renderVoiceStatus();

  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return;

  if (ch.type === 'voice') {
    if (activeVoiceChannelId === channelId) {
      renderVoiceRoom(ch, true);
    } else {
      if (activeVoiceChannelId) {
        await leaveVoiceChannel();
        updateVoicePresence(null);
      }
      activeVoiceChannelId = channelId;
      renderVoiceRoom(ch, false);
      renderVoiceStatus();
      updateVoicePresence(channelId);
    }
  } else {
    renderTextChannel(ch);
  }
}

let subscribedVideoTracks = new Map(); // Store tracks mapped by identity

/* ============================================================
   Voice Room UI & Presence
   ============================================================ */
function renderVoiceRoom(ch, maintainConnection = false) {
  mainContent.innerHTML = `
    <div class="voice-room">
      <div class="voice-room-header">
        <span class="voice-room-icon">🎙️</span>
        <span class="voice-room-name">${escapeHtml(ch.name)}</span>
        <span class="voice-room-status" id="voice-status">Connecting…</span>
      </div>
      <div class="voice-participants" id="voice-participants">
        <div class="voice-connecting">
          <div class="voice-spinner"></div>
          <p>Joining voice channel…</p>
        </div>
      </div>
      
      <!-- Video Stage -->
      <div id="voice-stage" class="voice-stage hidden"></div>

      <!-- Screen Share Cards Overlay -->
      <div id="screen-share-toast-container" class="screen-share-toast-container"></div>

      <div class="voice-controls">
        <button class="voice-btn voice-share-btn" id="voice-share-btn" title="Share Screen">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/>
             <path d="M8 21h8"/>
             <path d="M12 17v4"/>
             <path d="M17 8l5-5"/>
             <path d="M17 3h5v5"/>
          </svg>
          <span>Share</span>
        </button>

        <button class="voice-btn voice-mute-btn" id="voice-mute-btn" title="Mute">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <span>Mute</span>
        </button>
        <button class="voice-btn voice-leave-btn" id="voice-leave-btn" title="Leave">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span>Leave</span>
        </button>
      </div>
    </div>
  `;

  const muteBtn = $('#voice-mute-btn');
  const leaveBtn = $('#voice-leave-btn');
  const shareBtn = $('#voice-share-btn');
  const statusEl = $('#voice-status');
  const participantsEl = $('#voice-participants');
  const stageEl = $('#voice-stage');
  const toastContainer = $('#screen-share-toast-container');

  muteBtn.addEventListener('click', toggleAppMute);
  leaveBtn.addEventListener('click', disconnectVoice);
  shareBtn.addEventListener('click', toggleAppScreenShare);

  participantsEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('row-watch-btn')) {
      const identity = e.target.dataset.identity;
      const isWatching = e.target.dataset.watching === 'true';
      const trackData = subscribedVideoTracks.get(identity);

      if (!trackData) return;

      if (isWatching) {
        // Stop watching
        const wrapper = document.getElementById(`video-${trackData.trackSid}`);
        if (wrapper) {
          trackData.track.detach(wrapper.querySelector('video'));
          wrapper.remove();
        }
        e.target.dataset.watching = 'false';
        e.target.textContent = 'Watch';
        e.target.classList.remove('active');

        if (stageEl.querySelectorAll('.voice-video-wrapper').length === 0) {
          stageEl.classList.add('hidden');
        }
      } else {
        // Start watching
        const el = trackData.track.attach();
        el.controls = true;
        el.className = 'voice-video-element';

        const wrapper = document.createElement('div');
        wrapper.className = 'voice-video-wrapper';
        wrapper.id = `video-${trackData.trackSid}`;

        const label = document.createElement('div');
        label.className = 'voice-video-label';
        label.textContent = escapeHtml(trackData.sharerName);

        wrapper.appendChild(el);
        wrapper.appendChild(label);
        stageEl.appendChild(wrapper);
        stageEl.classList.remove('hidden');

        e.target.dataset.watching = 'true';
        e.target.textContent = 'Stop';
        e.target.classList.add('active');
      }
    }
  });

  const room = getActiveRoom();
  if (room && room.localParticipant.isScreenShareEnabled) {
    [shareBtn, document.getElementById('sidebar-share-btn')].forEach(btn => {
      if (btn) {
        btn.classList.add('active');
        const span = btn.querySelector('span');
        if (span) span.textContent = 'Stop Share';
      }
    });
  }
  updateMuteUI(isMuted());

  const handleTrackSubscribed = (track, publication, participant) => {
    if (track.kind === 'video') {
      const sharerName = participant.identity === currentUser.id ? 'You' : (participant.name || participant.identity);
      subscribedVideoTracks.set(participant.identity, {
        trackSid: publication.trackSid,
        track: track,
        sharerName: sharerName
      });
      // Force UI update to show the Watch button
      if (getActiveRoom()) renderParticipants(participantsEl, Array.from(getActiveRoom().remoteParticipants.values()));
    }
  };

  const handleTrackUnsubscribed = (track, publication, participant) => {
    if (track.kind === 'video') {
      const wrapper = document.getElementById(`video-${publication.trackSid}`);
      if (wrapper) wrapper.remove();

      subscribedVideoTracks.delete(participant.identity);

      if (stageEl.querySelectorAll('.voice-video-wrapper').length === 0) {
        stageEl.classList.add('hidden');
      }

      // Force UI update to hide the Watch button
      if (getActiveRoom()) renderParticipants(participantsEl, Array.from(getActiveRoom().remoteParticipants.values()));
    }
  };

  const callbacks = {
    onParticipantsChanged: (participants) => {
      renderParticipants(participantsEl, participants);
      updateMuteUI(isMuted());
    },
    onConnectionStateChanged: (state) => {
      const labels = {
        connected: 'Connected',
        connecting: 'Connecting…',
        reconnecting: 'Reconnecting…',
        disconnected: 'Disconnected',
      };
      if (statusEl) statusEl.textContent = labels[state] || state;
    },
    onTrackSubscribed: handleTrackSubscribed,
    onTrackUnsubscribed: handleTrackUnsubscribed
  };

  if (maintainConnection) {
    if (statusEl) statusEl.textContent = 'Connected';
    setVoiceCallbacks(callbacks);

    // Resume video tracks? 
    // If we reconnect to view, we might miss 'TrackSubscribed' events that happened before.
    // We should iterate existing tracks.
    const room = getActiveRoom();
    if (room) {
      room.remoteParticipants.forEach(p => {
        p.trackPublications.forEach(pub => {
          if (pub.kind === 'video' && pub.isSubscribed && pub.track) {
            handleTrackSubscribed(pub.track, pub, p);
          }
        });
      });
      // Also local?
      // Local screen share?
    }

  } else {
    joinVoiceChannel(ch.id, ch.name, callbacks).then(() => {
      updateVoicePresence(ch.id);
    }).catch((err) => {
      console.error('Voice join error:', err);
      if (participantsEl) {
        participantsEl.innerHTML = `<div class="voice-error">❌ Failed to join: ${escapeHtml(err.message)}</div>`;
      }
      if (statusEl) statusEl.textContent = 'Error';
    });
  }
}


function getUserDetails(identity) {
  // Check fresh profileCache first (Bug 1 fix: live avatar updates)
  const cached = profileCache.get(identity);

  if (currentUser && currentUser.id === identity) {
    return {
      name: currentProfile?.username || (currentUser.email ? currentUser.email.split('@')[0] : 'Me'),
      avatarUrl: currentProfile?.avatar_url,
      isDeafened: getIsDeafened()
    };
  }
  // Try profileCache for the freshest data
  if (cached) {
    // Also check presence for deafen status
    let isDeafened = false;
    for (const cid in channelPresences) {
      const user = channelPresences[cid].find(u => u.user_id === identity);
      if (user) { isDeafened = user.is_deafened; break; }
    }
    return { name: cached.username || 'Unknown', avatarUrl: cached.avatar_url, isDeafened };
  }
  for (const cid in channelPresences) {
    const user = channelPresences[cid].find(u => u.user_id === identity);
    if (user) return { name: user.username || 'Unknown', avatarUrl: user.avatar_url, isDeafened: user.is_deafened };
  }
  return { name: identity, avatarUrl: null, isDeafened: false };
}

function renderParticipants(container, participants) {
  if (!container) return;
  if (participants.length === 0) {
    container.innerHTML = '<div class="voice-empty">No one else here yet…</div>';
    return;
  }

  container.innerHTML = participants.map((p) => {
    let { name, avatarUrl, isDeafened } = getUserDetails(p.identity);
    if (p.isLocal) isDeafened = getIsDeafened(); // local user: use live deafen state, not presence/identity lookup
    const initial = (name || '?').charAt(0).toUpperCase();
    const avatarStyle = avatarUrl ? `background-image: url('${escapeHtml(avatarUrl)}');` : '';
    const avatarClass = avatarUrl ? 'participant-avatar-img' : 'participant-avatar-placeholder';

    // Icons
    let statusIcons = '';
    if (isDeafened) {
      statusIcons += `<svg class="status-icon red" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
        <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>`;
    }
    if (p.isMuted) {
      statusIcons += `<svg class="status-icon red" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    }

    const isStreaming = p.isScreenShareEnabled;
    const isLocal = p.isLocal;
    let liveUI = '';

    if (isStreaming) {
      if (isLocal) {
        liveUI = `<div class="status-live-badge">LIVE</div>`;
      } else {
        const isWatching = document.getElementById(`video-btn-state-${p.identity}`)?.dataset?.watching === 'true' || false;
        const btnText = isWatching ? 'Stop' : 'Watch';
        const btnClass = isWatching ? 'row-watch-btn active' : 'row-watch-btn';
        liveUI = `
          <div class="status-live-badge">LIVE</div>
          <button class="${btnClass}" data-identity="${escapeHtml(p.identity)}" id="video-btn-state-${escapeHtml(p.identity)}" data-watching="${isWatching}">${btnText}</button>
        `;
      }
    }

    return `
    <div class="voice-participant-row ${p.isSpeaking ? 'speaking' : ''} ${p.isMuted ? 'muted' : ''}" data-identity="${escapeHtml(p.identity)}" data-is-local="${p.isLocal}">
      <div class="participant-avatar ${avatarClass}" style="${avatarStyle}">
        ${!avatarUrl ? initial : ''}
      </div>
      
      <div class="participant-info" style="display: flex; align-items: center; gap: 8px;">
        <div class="participant-name">${escapeHtml(name)}</div>
        ${liveUI}
      </div>
      
      <div class="participant-actions">
        <div class="status-icon-container" style="display: flex; gap: 8px;">
          ${statusIcons}
        </div>
      </div>
    </div>
    `;
  }).join('');

  // Attach right-click context menu to remote participants
  container.querySelectorAll('.voice-participant-row').forEach(row => {
    if (row.dataset.isLocal === 'true') return;
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showParticipantContextMenu(e, row.dataset.identity);
    });
  });
}

// ── Participant Context Menu (Bug 2 + Bug 4 fix) ───────────────────────────
let activeContextMenu = null;

function dismissContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function showParticipantContextMenu(event, identity) {
  dismissContextMenu();

  const { name } = getUserDetails(identity);
  const currentVol = participantVolumes.get(identity) ?? 1;
  const volPercent = Math.round(currentVol * 100);

  const menu = document.createElement('div');
  menu.className = 'participant-context-menu';
  menu.innerHTML = `
    <div class="ctx-header">${escapeHtml(name)}</div>
    <div class="ctx-item">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg>
      <span class="ctx-vol-label">Volume: ${volPercent}%</span>
    </div>
    <input type="range" class="ctx-volume-slider" min="0" max="1" step="0.05" value="${currentVol}">
  `;

  // Position near the click
  menu.style.position = 'fixed';
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  const slider = menu.querySelector('.ctx-volume-slider');
  const label = menu.querySelector('.ctx-vol-label');
  slider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    participantVolumes.set(identity, val);
    setParticipantVolume(identity, val);
    label.textContent = `Volume: ${Math.round(val * 100)}%`;
  });

  // Prevent clicks inside from dismissing
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('contextmenu', (e) => e.stopPropagation());

  // Dismiss on outside click or escape
  setTimeout(() => {
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        dismissContextMenu();
        document.removeEventListener('click', dismiss);
        document.removeEventListener('contextmenu', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('contextmenu', dismiss);
  }, 0);

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      dismissContextMenu();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

// Global helper for volume (Bug 4 fix: persist in map)
window.setParticipantVol = (id, val) => {
  const v = parseFloat(val);
  participantVolumes.set(id, v);
  setParticipantVolume(id, v);
};

function renderVoiceStatus() {
  _renderVoiceStatus();
}

async function disconnectVoice() {
  await leaveVoiceChannel();
  updateVoicePresence(null);
  activeVoiceChannelId = null;
  renderVoiceStatus();

  // 1. Reset Deafen state
  setDeafen(false);
  const dBtn = document.getElementById('deafen-btn');
  if (dBtn) {
    dBtn.classList.remove('active');
    dBtn.title = 'Deafen';
  }

  // 2. Reset Mute state UI
  updateMuteUI(false);

  // 3. Reset Screen Share UI
  const shareBtns = [document.getElementById('voice-share-btn'), document.getElementById('sidebar-share-btn')];
  shareBtns.forEach(btn => {
    if (btn) {
      btn.classList.remove('active');
      const span = btn.querySelector('span');
      if (span) span.textContent = 'Share';
    }
  });

  if (channels.find(c => c.id === activeChannelId && c.type === 'voice')) {
    // If currently viewing the voice channel, go to empty state
    const srv = servers.find((s) => s.id === activeServerId);
    activeChannelId = null;
    renderChannels();
    mainContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <h2>Welcome to ${escapeHtml(srv?.name || 'server')}</h2>
        <p>Select a channel to start chatting.</p>
      </div>
    `;
  }
}

async function initPresence() {
  if (presenceChannel) supabase.removeChannel(presenceChannel);
  presenceChannel = supabase.channel('online-users');

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      // Transform: { id: [payloads] }
      channelPresences = {};

      Object.values(state).flat().forEach(user => {
        if (user.channel_id) {
          if (!channelPresences[user.channel_id]) channelPresences[user.channel_id] = [];
          channelPresences[user.channel_id].push(user);
        }
      });
      // Reflect our own live mute/deafen immediately (avoids presence round-trip lag)
      if (currentUser) {
        for (const cid in channelPresences) {
          const me = channelPresences[cid].find(u => u.user_id === currentUser.id);
          if (me) { me.is_deafened = getIsDeafened(); me.is_muted = isMuted(); }
        }
      }
      renderChannels();
      notifyParticipants(); // Force re-render of active voice room
    })
    .subscribe();
}

async function updateVoicePresence(channelId) {
  if (!presenceChannel) return;

  // Get current status from imported functions
  const muted = isMuted();
  const deafened = getIsDeafened();

  // Check if actively sharing screen
  let isStreaming = false;
  const room = getActiveRoom();
  if (room && room.localParticipant) {
    isStreaming = room.localParticipant.isScreenShareEnabled;
  }

  await presenceChannel.track({
    user_id: currentUser.id,
    username: currentProfile?.username || 'User',
    avatar_url: currentProfile?.avatar_url,
    channel_id: channelId,
    type: channelId ? 'voice' : 'idle',
    online_at: new Date().toISOString(),
    is_muted: muted,
    is_deafened: deafened,
    is_streaming: isStreaming
  });
}

function updateMuteUI(muted) {
  // Update Voice Room Button
  const roomBtn = $('#voice-mute-btn');
  if (roomBtn) {
    roomBtn.classList.toggle('active', muted);
    const span = roomBtn.querySelector('span');
    if (span) span.textContent = muted ? 'Unmute' : 'Mute';
    roomBtn.title = muted ? 'Unmute' : 'Mute';
  }

  // Update Sidebar Button
  if (sidebarMuteBtn) {
    sidebarMuteBtn.classList.toggle('active', muted);
    sidebarMuteBtn.title = muted ? 'Unmute' : 'Mute';
    if (muted) {
      sidebarMuteBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    } else {
      sidebarMuteBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    }
  }
}

/* ============================================================
   Text Channel UI
   ============================================================ */
function renderTextChannel(ch) {
  // Clear any existing staged file when switching channels
  stagedAttachment = null;

  mainContent.innerHTML = `
    <div class="chat-container" id="chat-container" style="display:flex; flex-direction:column; height:100%; position:relative;">
      <!-- Dropzone Overlay -->
      <div id="chat-dropzone" class="chat-dropzone hidden">
        <div class="dropzone-content">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <h2>Drop file to upload</h2>
        </div>
      </div>

      <div class="text-channel-header">
        <h3><span class="header-hash">#</span> ${escapeHtml(ch.name)}</h3>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-welcome" style="margin-bottom: 20px;">
          <h3 style="font-size: 1.5rem; margin-bottom: 8px;">Welcome to #${escapeHtml(ch.name)}</h3>
          <p style="color: var(--text-muted); font-size: 0.95rem;">This is the start of the channel.</p>
        </div>
      </div>
      
      <!-- Attachment Preview Area -->
      <div class="attachment-preview-area hidden" id="attachment-preview-area">
        <div class="attachment-preview-card" id="attachment-preview-card">
          <button class="attachment-clear-btn" id="attachment-clear-btn" title="Remove attachment">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <div class="attachment-preview-content" id="attachment-preview-content"></div>
        </div>
      </div>

      <!-- Typing Indicator Area -->
      <div id="typing-indicator" class="typing-indicator hidden" style="padding: 0 24px 8px 24px; font-size: 0.8rem; color: var(--text-muted); font-style: italic; min-height: 24px; transition: opacity 0.2s;">
      </div>

      <div class="chat-input-area">
        <input type="file" id="chat-file-input" style="display: none;" />
        <div class="chat-form">
          <button class="btn-attach" id="chat-attach-btn" title="Add Attachment">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
            </svg>
          </button>
          <input class="chat-input" id="chat-input" type="text"
                 placeholder="Message #${escapeHtml(ch.name)}" maxlength="2000" autocomplete="off" />
          <button class="btn-send" id="chat-send-btn" title="Send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  const chatInput = $('#chat-input');
  const sendBtn = $('#chat-send-btn');
  const attachBtn = $('#chat-attach-btn');
  const fileInput = $('#chat-file-input');
  const previewArea = $('#attachment-preview-area');
  const previewContent = $('#attachment-preview-content');
  const clearBtn = $('#attachment-clear-btn');
  const chatContainer = $('#chat-container');
  const dropzone = $('#chat-dropzone');

  // Drag & Drop Logic
  let dragCounter = 0;

  chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropzone.classList.remove('hidden');
  });

  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dropzone.classList.add('hidden');
    }
  });

  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault(); 
  });

  chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropzone.classList.add('hidden');

    const file = e.dataTransfer.files[0];
    if (!file) return;

    if (file.size > 30 * 1024 * 1024) { 
      alert('File is too large! Maximum attachment size is 30MB.');
      return;
    }

    stagedAttachment = file;
    previewArea.classList.remove('hidden');

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      previewContent.innerHTML = `<img src="${url}" alt="Attachment preview" />`;
    } else {
      previewContent.innerHTML = `
        <div class="file-preview-icon">📄</div>
        <div class="file-preview-name">${escapeHtml(file.name)}</div>
      `;
    }
  });

  // Attachment Logic 
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 30 * 1024 * 1024) { // 30MB
      alert('File is too large! Maximum attachment size is 30MB.');
      fileInput.value = '';
      return;
    }

    stagedAttachment = file;
    previewArea.classList.remove('hidden');

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      previewContent.innerHTML = `<img src="${url}" alt="Attachment preview" />`;
    } else {
      previewContent.innerHTML = `
        <div class="file-preview-icon">📄</div>
        <div class="file-preview-name">${escapeHtml(file.name)}</div>
      `;
    }
  });

  clearBtn.addEventListener('click', () => {
    stagedAttachment = null;
    fileInput.value = '';
    previewArea.classList.add('hidden');
    previewContent.innerHTML = '';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(chatInput);
    }
  });

  let lastTypingTime = 0;
  chatInput.addEventListener('input', () => {
    const now = Date.now();
    // Throttle firing broadcast to once every 2 seconds
    if (now - lastTypingTime > 2000 && realtimeSub && currentUser) {
      if (chatInput.value.trim() !== '') {
        const username = profileCache.get(currentUser.id)?.username || 'Unknown';
        realtimeSub.send({
          type: 'broadcast',
          event: 'typing',
          payload: { user_id: currentUser.id, username }
        });
        lastTypingTime = now;
      }
    }
  });

  sendBtn.addEventListener('click', () => sendMessage(chatInput));
  chatInput.focus();

  loadMessages(ch.id);
  subscribeToChannel(ch.id);
}

/* ============================================================
   Messages — Load, Render, Send (Bubble Style)
   ============================================================ */
async function loadMessages(channelId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content, user_id, created_at, attachment_url, attachment_type, attachment_name')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('Failed to load messages:', error);
    return;
  }

  messages = data || [];

  const authorIds = [...new Set(messages.map((m) => m.user_id))];
  await fetchProfiles(authorIds);

  renderAllMessages();
  scrollToBottom();
}

async function fetchProfiles(userIds) {
  const missing = userIds.filter((uid) => !profileCache.has(uid));
  if (missing.length === 0) return;

  const { data } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .in('id', missing);

  (data || []).forEach((p) => profileCache.set(p.id, p));
}

function renderAllMessages() {
  const container = $('#chat-messages');
  if (!container) return;

  const welcome = container.querySelector('.chat-welcome');
  container.innerHTML = '';
  if (welcome) container.appendChild(welcome);

  messages.forEach((msg, i) => {
    const prev = i > 0 ? messages[i - 1] : null;
    container.appendChild(createMessageEl(msg, prev));
  });
}


function parseMarkdown(text) {
  // First escape HTML to prevent XSS
  let escaped = escapeHtml(text);
  
  // Markdown parsing
  // Bold
  escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  escaped = escaped.replace(/(?<!\*)\*([^\*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  escaped = escaped.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '<em>$1</em>');
  // Strikethrough
  escaped = escaped.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
  // Inline code
  escaped = escaped.replace(/`([^`\n]+?)`/g, '<code class="msg-markdown-code">$1</code>');

  // Relink URLs
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => `<a href="#" class="chat-link" data-url="${url}">${url}</a>`
  );
}

// Delegate chat link clicks to open via Tauri's system browser command
document.addEventListener('click', (e) => {
  const link = e.target.closest('.chat-link');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.url;
  if (!url) return;
  // Use the Tauri v2 invoke API to open in system default browser
  invoke('open_url', { url }).catch(() => {
    // Fallback if not running inside Tauri
    window.open(url, '_blank');
  });
});


function createMessageEl(msg, prevMsg) {

  const profile = profileCache.get(msg.user_id) || { username: 'Unknown' };
  const authorName = profile.username || 'Unknown';
  const initial = authorName.charAt(0).toUpperCase();
  const isOwn = msg.user_id === currentUser?.id;

  const showHeader = !prevMsg ||
    prevMsg.user_id !== msg.user_id ||
    (new Date(msg.created_at) - new Date(prevMsg.created_at)) > 5 * 60 * 1000;

  const time = new Date(msg.created_at);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = 'message' + (isOwn ? ' self' : '');
  div.dataset.id = msg.id;

  let attachmentHtml = '';
  if (msg.attachment_url) {
    if (msg.attachment_type && msg.attachment_type.startsWith('image/')) {
      attachmentHtml = `<div class="msg-attachment"><img src="${escapeHtml(msg.attachment_url)}" alt="Attachment" class="chat-attachment-img" loading="lazy" onclick="window.openLightbox('${escapeHtml(msg.attachment_url)}')" /></div>`;
    } else {
      const fileName = msg.attachment_name || 'Download File';
      let forceDownloadUrl = msg.attachment_url;
      try {
        const urlObj = new URL(msg.attachment_url);
        urlObj.searchParams.set('download', fileName);
        forceDownloadUrl = urlObj.toString();
      } catch (e) {
        forceDownloadUrl = msg.attachment_url + (msg.attachment_url.includes('?') ? '&' : '?') + 'download=';
      }

      attachmentHtml = `
        <div class="msg-attachment">
          <a href="#" data-url="${escapeHtml(forceDownloadUrl)}" class="chat-attachment-file chat-link">
            <span class="file-icon">📄</span>
            <span class="file-name">${escapeHtml(fileName)}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </a>
        </div>
      `;
    }
  }

  // Only render the text div if there is actual text content
  const textHtml = msg.content ? `<div class="msg-text">${parseMarkdown(msg.content)}</div>` : '';

  // Only show delete button if it's our own message or we have permission
  let deleteBtnHtml = '';
  if (isOwn || hasPermission('delete_messages')) {
    deleteBtnHtml = `
      <button class="msg-delete-btn" onclick="deleteMessage('${msg.id}')" title="Delete Message">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      </button>
    `;
  }

  if (showHeader) {
    div.innerHTML = `
      <div class="msg-avatar" style="${profile.avatar_url ? `background-image: url('${profile.avatar_url}')` : ''}">${profile.avatar_url ? '' : initial}</div>
      <div class="msg-content">
        <div class="msg-header">
          <span class="msg-author">${escapeHtml(authorName)}</span>
          <span class="msg-time">${timeStr}</span>
          ${deleteBtnHtml}
        </div>
        ${textHtml}
        ${attachmentHtml}
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="msg-avatar" style="opacity: 0"></div>
      <div class="msg-content">
        <div class="msg-header-inline">${deleteBtnHtml}</div>
        ${textHtml}
        ${attachmentHtml}
      </div>
    `;
  }

  return div;
}

window.deleteMessage = async (msgId) => {
  if (!confirm('Are you sure you want to delete this message?')) return;

  const targetMsg = messages.find(m => m.id === msgId);
  const isOwn = targetMsg && targetMsg.user_id === currentUser.id;

  let deleteError = null;

  if (isOwn) {
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', msgId)
      .eq('user_id', currentUser.id);
    deleteError = error;
  } else {
    const { error } = await supabase.rpc('delete_message_as_admin', { p_message_id: msgId });
    deleteError = error;
  }

  if (deleteError) {
    console.error('Error deleting message:', deleteError);
    alert('Failed to delete message: ' + deleteError.message);
    return;
  }

  // Remove from local array and DOM
  messages = messages.filter(m => m.id !== msgId);
  const msgEl = document.querySelector(`.message[data-id="${msgId}"]`);
  if (msgEl) msgEl.remove();
};

function scrollToBottom() {
  const container = $('#chat-messages');
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

async function sendMessage(inputEl) {
  const content = inputEl.value.trim();
  const fileToUpload = stagedAttachment;

  if (!content && !fileToUpload) return;
  if (!activeChannelId) return;

  const originalPlaceholder = inputEl.placeholder;
  let attachmentUrl = null;
  let attachmentType = null;
  let attachmentName = null;

  // Clear UI early to feel snappy
  inputEl.value = '';
  const clearBtn = $('#attachment-clear-btn');
  if (clearBtn) clearBtn.click(); // resets stagedAttachment and hids preview logically

  if (fileToUpload) {
    inputEl.placeholder = 'Uploading...';
    inputEl.disabled = true;

    const fileExt = fileToUpload.name.split('.').pop();
    const filePath = `${activeChannelId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('chat-attachments')
      .upload(filePath, fileToUpload);

    if (uploadError) {
      console.error('File upload failed:', uploadError);
      alert('Failed to upload file. Please try again.');
      inputEl.disabled = false;
      inputEl.placeholder = originalPlaceholder;
      inputEl.value = content; // restore text
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from('chat-attachments')
      .getPublicUrl(filePath);

    if (publicUrlData && publicUrlData.publicUrl) {
      attachmentUrl = publicUrlData.publicUrl;
      attachmentType = fileToUpload.type;
      attachmentName = fileToUpload.name;
    }

    inputEl.disabled = false;
    inputEl.placeholder = originalPlaceholder;
    inputEl.focus();
  }

  const { error } = await supabase
    .from('messages')
    .insert({
      channel_id: activeChannelId,
      user_id: currentUser.id,
      content,
      attachment_url: attachmentUrl,
      attachment_type: attachmentType,
      attachment_name: attachmentName
    });

  if (error) {
    console.error('Failed to send message:', error);
    inputEl.value = content;
  }
}

/* ============================================================
   Realtime Subscription
   ============================================================ */
let typingUsers = new Map();

function handleTypingMetadata({ payload }) {
  if (!currentUser || payload.user_id === currentUser.id) return;
  
  if (typingUsers.has(payload.user_id)) {
    clearTimeout(typingUsers.get(payload.user_id).timeout);
  }

  typingUsers.set(payload.user_id, {
    username: payload.username,
    timeout: setTimeout(() => {
      typingUsers.delete(payload.user_id);
      updateTypingUI();
    }, 3000)
  });
  
  updateTypingUI();
}

function updateTypingUI() {
  const indicator = document.getElementById('typing-indicator');
  if (!indicator) return;
  
  if (typingUsers.size === 0) {
    indicator.classList.add('hidden');
    indicator.innerText = '';
  } else {
    indicator.classList.remove('hidden');
    const names = Array.from(typingUsers.values()).map(u => u.username);
    if (names.length === 1) {
      indicator.innerText = `${escapeHtml(names[0])} is typing...`;
    } else if (names.length === 2) {
      indicator.innerText = `${escapeHtml(names[0])} and ${escapeHtml(names[1])} are typing...`;
    } else {
      indicator.innerText = `Several people are typing...`;
    }
  }
}

function subscribeToChannel(channelId) {
  if (realtimeSub) {
    supabase.removeChannel(realtimeSub);
  }

  // Clear typing cache when switching channels
  typingUsers.forEach(u => clearTimeout(u.timeout));
  typingUsers.clear();
  updateTypingUI();

  realtimeSub = supabase
    .channel(`messages:${channelId}`)
    .on('broadcast', { event: 'typing' }, handleTypingMetadata)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      async (payload) => {
        const newMsg = payload.new;

        if (messages.some((m) => m.id === newMsg.id)) return;

        await fetchProfiles([newMsg.user_id]);

        messages.push(newMsg);

        const container = $('#chat-messages');
        if (container) {
          const prev = messages.length > 1 ? messages[messages.length - 2] : null;
          container.appendChild(createMessageEl(newMsg, prev));

          const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
          if (isNearBottom) scrollToBottom();
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      (payload) => {
        const deletedId = payload.old.id;

        // Remove from local array cache
        messages = messages.filter(m => m.id !== deletedId);

        // Remove from DOM
        const el = document.querySelector(`.message[data-id="${deletedId}"]`);
        if (el) {
          el.remove();
        }
      }
    )
    .subscribe();
}

/* ============================================================
   Create Server Modal
   ============================================================ */
createServerBtn.addEventListener('click', () => {
  createServerModalOverlay.classList.remove('hidden');
  $('#server-name-input').value = '';
  $('#server-name-input').focus();
});
createServerCancel.addEventListener('click', () => createServerModalOverlay.classList.add('hidden'));
createServerModalOverlay.addEventListener('click', (e) => {
  if (e.target === createServerModalOverlay) createServerModalOverlay.classList.add('hidden');
});

createServerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#server-name-input').value.trim();
  if (!name) return;

  const { data: server, error: srvErr } = await supabase
    .from('servers')
    .insert({ name, owner_id: currentUser.id })
    .select()
    .single();

  if (srvErr) {
    console.error('Failed to create server:', srvErr);
    alert('Failed to create server: ' + srvErr.message);
    return;
  }

  const { error: memErr } = await supabase
    .from('server_members')
    .insert({ server_id: server.id, user_id: currentUser.id, role: 'owner' });

  if (memErr) console.error('Failed to join server:', memErr);

  await supabase
    .from('channels')
    .insert({ server_id: server.id, name: 'general', type: 'text', created_by: currentUser.id });

  createServerModalOverlay.classList.add('hidden');
  await loadServers();
  selectServer(server.id);
});

/* ============================================================
   Join Server Modal
   ============================================================ */
joinServerBtn.addEventListener('click', () => {
  joinServerModalOverlay.classList.remove('hidden');
  joinServerError.classList.add('hidden');
  $('#invite-code-input').value = '';
  $('#invite-code-input').focus();
});
joinServerCancel.addEventListener('click', () => joinServerModalOverlay.classList.add('hidden'));
joinServerModalOverlay.addEventListener('click', (e) => {
  if (e.target === joinServerModalOverlay) joinServerModalOverlay.classList.add('hidden');
});

joinServerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  joinServerError.classList.add('hidden');
  const code = $('#invite-code-input').value.trim().toLowerCase();
  if (!code) return;

  const { data: server, error: lookupErr } = await supabase
    .from('servers')
    .select('id, name')
    .eq('invite_code', code)
    .single();

  if (lookupErr || !server) {
    joinServerError.textContent = 'Invalid invite code. Please try again.';
    joinServerError.classList.remove('hidden');
    return;
  }

  const { data: existing } = await supabase
    .from('server_members')
    .select('id')
    .eq('server_id', server.id)
    .eq('user_id', currentUser.id)
    .maybeSingle();

  if (existing) {
    joinServerModalOverlay.classList.add('hidden');
    selectServer(server.id);
    return;
  }

  const { error: joinErr } = await supabase
    .from('server_members')
    .insert({ server_id: server.id, user_id: currentUser.id, role: 'member' });

  if (joinErr) {
    joinServerError.textContent = 'Failed to join: ' + joinErr.message;
    joinServerError.classList.remove('hidden');
    return;
  }

  joinServerModalOverlay.classList.add('hidden');
  await loadServers();
  selectServer(server.id);
});

/* ============================================================
   Create Channel Modal (scoped to active server)
   ============================================================ */
channelModalCancel.addEventListener('click', () => channelModalOverlay.classList.add('hidden'));
channelModalOverlay.addEventListener('click', (e) => {
  if (e.target === channelModalOverlay) channelModalOverlay.classList.add('hidden');
});

createChannelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#channel-name-input').value.trim();
  const type = $('#channel-type-input').value;
  if (!name || !activeServerId) return;

  const isPrivate = document.getElementById('channel-is-private')?.checked || false;
  let allowedRoles = null;

  if (isPrivate) {
    const checkedRoles = document.querySelectorAll('#private-roles-list input[type=checkbox]:checked');
    allowedRoles = Array.from(checkedRoles).map(cb => cb.value);
    if (allowedRoles.length === 0) {
      alert('Please select at least one role for the private channel.');
      return;
    }
  }

  const insertData = { server_id: activeServerId, name, type, created_by: currentUser.id, is_private: isPrivate };
  if (allowedRoles) insertData.allowed_roles = allowedRoles;

  const { data: channel, error: chErr } = await supabase
    .from('channels')
    .insert(insertData)
    .select()
    .single();

  if (chErr) {
    console.error('Failed to create channel:', chErr);
    alert('Failed to create channel: ' + chErr.message);
    return;
  }

  channelModalOverlay.classList.add('hidden');
  await loadChannels();
  selectChannel(channel.id);
});

// Private channel toggle — show/hide role selector
const privateChannelToggle = document.getElementById('channel-is-private');
if (privateChannelToggle) {
  privateChannelToggle.addEventListener('change', async () => {
    const rolesContainer = document.getElementById('private-channel-roles');
    const rolesList = document.getElementById('private-roles-list');
    if (privateChannelToggle.checked) {
      rolesContainer.style.display = 'block';
      // Populate with roles from current server (fetched fresh — toggling private is rare)
      const { data } = await supabase
        .from('server_roles')
        .select('*')
        .eq('server_id', activeServerId)
        .order('position_num', { ascending: false });
      const roles = data || [];
      rolesList.innerHTML = '';
      if (roles.length === 0) {
        rolesList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem;">No roles created yet. Create roles in Server Settings first.</div>';
      } else {
        roles.forEach(role => {
          const label = document.createElement('label');
          label.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; font-size: 0.85rem; color: var(--text-secondary);';
          label.innerHTML = `
            <input type="checkbox" value="${role.id}" style="accent-color: ${escapeHtml(role.color)}" />
            <div style="width: 8px; height: 8px; border-radius: 50%; background: ${escapeHtml(role.color)};"></div>
            ${escapeHtml(role.name)}
          `;
          rolesList.appendChild(label);
        });
      }
    } else {
      rolesContainer.style.display = 'none';
    }
  });
}

/* ============================================================
   Utility
   ============================================================ */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================
   Settings Modal Logic (Phase 4.5)
   ============================================================ */
const settingsModal = document.getElementById('settings-modal-overlay');
const settingsBtn = document.getElementById('settings-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsTabs = document.querySelectorAll('.settings-tab[data-tab]');
const settingsPanes = document.querySelectorAll('.settings-pane');
const settingsProfileForm = document.getElementById('settings-profile-form');
const settingsUsernameInput = document.getElementById('settings-username');
const settingsAvatarPreview = document.getElementById('settings-avatar-preview');
// Removed: settingsAvatarInput (url input) replaced by file upload logic

const settingNoiseSuppression = document.getElementById('setting-noise-suppression');
const settingEchoCancellation = document.getElementById('setting-echo-cancellation');
const settingAutoGain = document.getElementById('setting-auto-gain');

function updateAvatarPreview(url) {
  if (!settingsAvatarPreview) return;
  if (url) {
    settingsAvatarPreview.style.backgroundImage = `url('${url}')`;
    settingsAvatarPreview.textContent = '';
  } else {
    settingsAvatarPreview.style.backgroundImage = 'none';
    if (settingsUsernameInput && settingsUsernameInput.value) {
      settingsAvatarPreview.textContent = settingsUsernameInput.value.charAt(0).toUpperCase();
    }
  }
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    if (currentProfile) {
      settingsUsernameInput.value = currentProfile.username || currentUser.email?.split('@')[0];
      updateAvatarPreview(currentProfile.avatar_url);
    } else {
      settingsUsernameInput.value = currentUser?.email?.split('@')[0] || 'User';
      updateAvatarPreview(null);
    }
    refreshVoiceSettings();
    settingsModal.classList.remove('hidden');
  });
}

if (settingsCloseBtn) {
  settingsCloseBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
}

settingsTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    settingsTabs.forEach(t => t.classList.remove('active'));
    settingsPanes.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const targetPane = document.getElementById(`pane-${tab.dataset.tab}`);
    if (targetPane) targetPane.classList.add('active');
  });
});




/* ============================================================
   Unified Voice Controls
   ============================================================ */
async function toggleAppMute() {
  const muted = await toggleMute();
  updateMuteUI(muted);
  // Only sync presence to the server when actually connected to a channel.
  if (activeVoiceChannelId) {
    await updateVoicePresence(activeVoiceChannelId);
  }
}

async function toggleAppDeafen() {
  const newState = !getIsDeafened();
  setDeafen(newState);

  // UI Update
  const btn = document.getElementById('deafen-btn');
  if (btn) {
    btn.classList.toggle('active', newState);
    btn.title = newState ? 'Undeafen' : 'Deafen';
  }

  // Sync Presence
  if (activeVoiceChannelId) {
    await updateVoicePresence(activeVoiceChannelId);
  }
  notifyParticipants(); // Force immediate UI update for local user
}

const shareSettingsModal = document.getElementById('screen-share-settings-modal');
const confirmShareBtn = document.getElementById('confirm-share-start');
const cancelShareBtn = document.getElementById('cancel-share-settings');
const fpsSelect = document.getElementById('screen-fps');

const openShareSettings = () => {
  if (shareSettingsModal) shareSettingsModal.classList.remove('hidden');
};

const closeShareSettings = () => {
  if (shareSettingsModal) shareSettingsModal.classList.add('hidden');
};

// Main toggle function
const toggleAppScreenShare = async () => {
  const room = getActiveRoom();
  if (!room) return;
  const shareBtns = [document.getElementById('voice-share-btn'), document.getElementById('sidebar-share-btn')];

  // Check strict state from room
  const isSharing = room.localParticipant.isScreenShareEnabled;

  if (isSharing) {
    // Stop sharing immediately
    try {
      shareBtns.forEach(btn => { if (btn) btn.disabled = true; });
      await toggleScreenShare(false);

      shareBtns.forEach(btn => {
        if (btn) {
          btn.classList.remove('active');
          const span = btn.querySelector('span');
          if (span) span.textContent = 'Share';
        }
      });

      // Remove local video wrapper
      const wrapper = document.getElementById(`video-local-screen`);
      if (wrapper) wrapper.remove();

      const stageEl = document.getElementById('voice-stage');
      if (stageEl && stageEl.children.length === 0) {
        stageEl.classList.add('hidden');
      }

    } catch (err) {
      console.error('Stop share error:', err);
    } finally {
      shareBtns.forEach(btn => { if (btn) btn.disabled = false; });
      await updateVoicePresence(activeVoiceChannelId);
    }
  } else {
    // Open settings before starting
    openShareSettings();
  }
};

if (confirmShareBtn) {
  confirmShareBtn.addEventListener('click', async () => {
    closeShareSettings();
    const room = getActiveRoom();
    if (!room) return;
    const shareBtns = [document.getElementById('voice-share-btn'), document.getElementById('sidebar-share-btn')];

    const fps = parseInt(fpsSelect ? fpsSelect.value : '30', 10);

    try {
      shareBtns.forEach(btn => { if (btn) btn.disabled = true; });
      await toggleScreenShare(true, { fps });

      shareBtns.forEach(btn => {
        if (btn) {
          btn.classList.add('active');
          const span = btn.querySelector('span');
          if (span) span.textContent = 'Stop Share';
        }
      });

      // Render local screen share
      setTimeout(() => {
        const localScreenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        if (localScreenPub && localScreenPub.track) {
          const el = localScreenPub.track.attach();
          el.controls = true; // Show native browser video controls
          el.className = 'voice-video-element';

          const wrapper = document.createElement('div');
          wrapper.className = 'voice-video-wrapper';
          wrapper.id = 'video-local-screen';

          const label = document.createElement('div');
          label.className = 'voice-video-label';
          label.textContent = 'Your Screen';

          wrapper.appendChild(el);
          wrapper.appendChild(label);

          const stageEl = document.getElementById('voice-stage');
          if (stageEl) {
            stageEl.appendChild(wrapper);
            stageEl.classList.remove('hidden');
          }
        }
      }, 500); // slight delay to allow LiveKit to publish

    } catch (err) {
      console.error('Start share error:', err);
      alert('Failed to start screen share: ' + err.message);
    } finally {
      shareBtns.forEach(btn => { if (btn) btn.disabled = false; });
      await updateVoicePresence(activeVoiceChannelId);
    }
  });
}

if (cancelShareBtn) {
  cancelShareBtn.addEventListener('click', closeShareSettings);
}

// Wire up the main voice stage share button explicitly
const mainStageShareBtn = document.getElementById('voice-share-btn');
if (mainStageShareBtn) {
  mainStageShareBtn.addEventListener('click', toggleAppScreenShare);
}

// Attach listener dynamically
const attachShareListener = () => {
  const btn = document.getElementById('voice-share-btn');
  if (btn) {
    btn.removeEventListener('click', toggleAppScreenShare); // prevent dupes
    btn.addEventListener('click', toggleAppScreenShare);
  }
};
// Run attachment
attachShareListener();

const handleTrackSubscribed = (track, publication, participant) => {
  // This function seems to be a placeholder or intended for a different scope.
  // If 'btn' refers to 'shareBtn', it should be used explicitly.
  // For now, keeping it as is, assuming 'btn' might be defined elsewhere or is a typo.
  // If 'btn' is meant to be 'shareBtn', it should be: if (shareBtn) shareBtn.disabled = false;
}

/* ============================================================
   Deafen Logic
   ============================================================ */
if (deafenBtn) {
  deafenBtn.addEventListener('click', toggleAppDeafen);
}

// Sidebar Mute Hook
if (sidebarMuteBtn) {
  sidebarMuteBtn.addEventListener('click', toggleAppMute);
}
// Reflect the persisted mute state on startup
updateMuteUI(isMuted());

// Sidebar Share Hook
if (sidebarShareBtn) {
  sidebarShareBtn.addEventListener('click', toggleAppScreenShare);
}

// Deprecated: use toggleAppDeafen
function toggleDeafenState() {
  toggleAppDeafen();
}

/* ============================================================
   Lightbox
   ============================================================ */
(function initLightbox() {
  const lb = document.createElement('div');
  lb.id = 'img-lightbox';
  lb.style.cssText = [
    'display:none',
    'position:fixed',
    'inset:0',
    'z-index:99999',
    'background:rgba(0,0,0,0.85)',
    'align-items:center',
    'justify-content:center',
    'cursor:zoom-out'
  ].join(';');
  const lbImg = document.createElement('img');
  lbImg.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.8);object-fit:contain;cursor:zoom-in;transition:transform 0.2s ease;';
  lb.appendChild(lbImg);
  document.body.appendChild(lb);

  let isZoomed = false;

  lb.addEventListener('click', () => {
    lb.style.display = 'none';
    isZoomed = false;
    lbImg.style.transform = 'scale(1)';
    lbImg.style.cursor = 'zoom-in';
  });

  lbImg.addEventListener('click', (e) => {
    // Prevent the click from bubbling up to the `lb` background which would close it
    e.stopPropagation();
    isZoomed = !isZoomed;
    lbImg.style.transform = isZoomed ? 'scale(1.75)' : 'scale(1)';
    lbImg.style.cursor = isZoomed ? 'zoom-out' : 'zoom-in';
  });

  window.openLightbox = (src) => {
    lbImg.src = src;
    isZoomed = false;
    lbImg.style.transform = 'scale(1)';
    lbImg.style.cursor = 'zoom-in';
    lb.style.display = 'flex';
  };
})();

/* ============================================================
   Keybind Manager
   ============================================================ */
let keybinds = JSON.parse(localStorage.getItem('vekini_keybinds')) || {
  TOGGLE_MUTE: 'KeyM',
  TOGGLE_DEAFEN: null,
  PUSH_TO_TALK: null
};

// Migrate old plain code-style binds to new format if needed
(function migrateKeybinds() {
  let changed = false;
  for (const [action, val] of Object.entries(keybinds)) {
    // Old format was bare event.code, new format keeps it as-is or chord "Ctrl+KeyM"
    // No migration needed unless explicitly malformed
    if (val && typeof val !== 'string') { keybinds[action] = null; changed = true; }
  }
  if (changed) localStorage.setItem('vekini_keybinds', JSON.stringify(keybinds));
})();

function saveKeybinds() {
  localStorage.setItem('vekini_keybinds', JSON.stringify(keybinds));
}

/** Turn a keyboard event into a canonical chord string like "Ctrl+Shift+KeyM" */
function eventToChord(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  // Only add the key if it's not a lone modifier
  const modifierCodes = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);
  if (!modifierCodes.has(e.code)) parts.push(e.code);
  return parts.join('+');
}

/** Format a stored chord string for display (e.g. "Ctrl+KeyM" → "Ctrl + M") */
function formatChord(chord) {
  if (!chord) return 'Unbound';
  return chord
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace(/\+/g, ' + ');
}

// Push-to-talk state tracking
let pttActive = false;

// Global KeyDown Listener — supports chords
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const chord = eventToChord(e);
  if (!chord) return;

  if (keybinds.PUSH_TO_TALK && chord === keybinds.PUSH_TO_TALK && !pttActive) {
    pttActive = true;
    // Unmute if muted (hold-to-talk)
    if (isMuted()) toggleAppMute();
  } else if (keybinds.TOGGLE_MUTE && chord === keybinds.TOGGLE_MUTE) {
    e.preventDefault();
    toggleAppMute();
  } else if (keybinds.TOGGLE_DEAFEN && chord === keybinds.TOGGLE_DEAFEN) {
    e.preventDefault();
    toggleAppDeafen();
  }
});

// Push-to-talk key release — re-mutes when key is released
document.addEventListener('keyup', (e) => {
  if (!pttActive) return;
  const chord = eventToChord(e);
  if (keybinds.PUSH_TO_TALK && chord === keybinds.PUSH_TO_TALK) {
    pttActive = false;
    // Re-mute after releasing PTT key
    if (!isMuted()) toggleAppMute();
  }
});


// SETTINGS UI EXTRACTED TO src/ui/settings.js
initSettingsModule({
  get currentUser() { return currentUser; },
  get currentProfile() { return currentProfile; },
  set currentProfile(v) { currentProfile = v; },
  get activeServerId() { return activeServerId; },
  set activeServerId(v) { activeServerId = v; },
  get servers() { return servers; },
  get keybinds() { return keybinds; },
  get profileCache() { return profileCache; },
  toggleAppMute, toggleAppDeafen, renderSidebar, hasPermission,
  loadServers, loadCurrentUserPermissions, escapeHtml,
  saveKeybinds, eventToChord,
  getAudioDevices, setInputDevice, setOutputDevice, updateAudioOptions
});

