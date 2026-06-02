import { supabase } from '../supabase.js';

let ctx;

export function initSidebarModule(context) {
  ctx = context;
}

/* ============================================================
   Sidebar: Server List
   ============================================================ */
export function renderSidebar() {
  const { sidebarServers, servers, activeServerId, currentUser, hasPermission, escapeHtml } = ctx;
  sidebarServers.innerHTML = '';
  servers.forEach((srv) => {
    const section = document.createElement('div');
    section.className = 'server-accordion' + (srv.id === activeServerId ? ' active' : '');
    section.dataset.serverId = srv.id;

    const header = document.createElement('div');
    header.className = 'server-header';
    const isOwner = currentUser && srv.owner_id === currentUser.id;
    const canAccessSettings = isOwner || (activeServerId === srv.id && (hasPermission('manage_channels') || hasPermission('manage_roles') || hasPermission('kick_members')));
    const settingsIconHtml = canAccessSettings ? `
      <div class="server-settings-icon" title="Server Settings" style="margin-right: 4px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; color: var(--text-muted); transition: all 0.2s;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </div>
    ` : '';

    let serverIconHtml = `<div class="server-icon">${escapeHtml(srv.name.charAt(0).toUpperCase())}</div>`;
    if (srv.icon_url) {
      serverIconHtml = `<div class="server-icon" style="background-image: url('${escapeHtml(srv.icon_url)}'); background-size: cover; background-position: center; border: none; color: transparent;"></div>`;
    }

    header.innerHTML = `
      ${serverIconHtml}
      <div class="server-name" style="flex: 1;">${escapeHtml(srv.name)}</div>
      ${settingsIconHtml}
      <svg class="server-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.closest('.server-settings-icon')) {
        e.stopPropagation();
        ctx.openServerSettingsModal(srv);
        return;
      }
      if (ctx.activeServerId === srv.id) {
        section.classList.toggle('active');
      } else {
        ctx.selectServer(srv.id);
      }
    });

    const channelsContainer = document.createElement('div');
    channelsContainer.className = 'server-channels';
    channelsContainer.id = `channels-${srv.id}`;

    section.appendChild(header);
    section.appendChild(channelsContainer);
    sidebarServers.appendChild(section);
  });
}

/* ============================================================
   Channels: Render inside server accordion
   ============================================================ */
export function renderChannels() {
  const { activeServerId, activeChannelId, channels, channelPresences, hasPermission, channelModalOverlay, escapeHtml } = ctx;
  const container = document.getElementById(`channels-${activeServerId}`);
  if (!container) return;

  container.innerHTML = '';

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'channel-item';
    empty.style.color = 'var(--text-muted)';
    empty.style.cursor = 'default';
    empty.style.fontSize = '0.85rem';
    empty.textContent = 'No channels yet';
    container.appendChild(empty);
  } else {
    channels.forEach((ch) => {
      const item = document.createElement('div');
      item.className = 'channel-item' + (ch.id === activeChannelId ? ' active' : '');
      item.dataset.id = ch.id;
      item.innerHTML = `
        <span class="channel-icon">${ch.type === 'voice' ? '🎙️' : (ch.is_private ? '🔒' : '💬')}</span>
        <span>${escapeHtml(ch.name)}</span>
      `;
      item.addEventListener('click', () => ctx.selectChannel(ch.id));

      const chUsers = channelPresences[ch.id] || [];
      if (chUsers.length > 0) {
        const usersDiv = document.createElement('div');
        usersDiv.className = 'sidebar-voice-participants';
        chUsers.forEach(u => {
          const uRow = document.createElement('div');
          uRow.className = 'sidebar-participant';
          const av = document.createElement('div');
          av.className = 'user-avatar';
          if (u.avatar_url) {
            av.style.backgroundImage = `url('${u.avatar_url}')`;
          } else {
            av.textContent = (u.username || '?').charAt(0).toUpperCase();
          }
          const nameCtx = document.createElement('span');
          nameCtx.textContent = u.username || 'Unknown';
          uRow.appendChild(av);
          uRow.appendChild(nameCtx);

          if (u.is_muted || u.is_deafened || u.is_streaming) {
            const statusContainer = document.createElement('div');
            statusContainer.style.cssText = 'display:flex;gap:4px;align-items:center;margin-left:auto;';
            if (u.is_streaming) {
              const liveBadge = document.createElement('div');
              liveBadge.className = 'status-live-badge';
              liveBadge.textContent = 'LIVE';
              statusContainer.appendChild(liveBadge);
            }
            if (u.is_muted) {
              const muteIcon = document.createElement('div');
              muteIcon.style.cssText = 'color:var(--danger);display:flex;';
              muteIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
              statusContainer.appendChild(muteIcon);
            }
            if (u.is_deafened) {
              const deafIcon = document.createElement('div');
              deafIcon.style.cssText = 'color:var(--danger);display:flex;';
              deafIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`;
              statusContainer.appendChild(deafIcon);
            }
            uRow.appendChild(statusContainer);
          }
          usersDiv.appendChild(uRow);
        });
        container.appendChild(item);
        container.appendChild(usersDiv);
      } else {
        container.appendChild(item);
      }
    });
  }

  if (hasPermission('manage_channels')) {
    const addBtn = document.createElement('div');
    addBtn.className = 'channel-item';
    addBtn.style.cssText = 'color:var(--accent);font-size:0.85rem;opacity:0.7;';
    addBtn.innerHTML = `<span class="channel-icon">＋</span><span>New Channel</span>`;
    addBtn.addEventListener('click', () => {
      if (!activeServerId) return;
      channelModalOverlay.classList.remove('hidden');
      document.querySelector('#channel-name-input').value = '';
      document.querySelector('#channel-name-input').focus();
      const privateToggle = document.getElementById('channel-is-private');
      if (privateToggle) privateToggle.checked = false;
      const rolesContainer = document.getElementById('private-channel-roles');
      if (rolesContainer) rolesContainer.style.display = 'none';
    });
    container.appendChild(addBtn);
  }
}

/* ============================================================
   Voice Status Bar (Sidebar)
   ============================================================ */
let pingInterval = null;

export function renderVoiceStatus() {
  const { activeVoiceChannelId, channels, escapeHtml, disconnectVoice } = ctx;
  const $ = (s) => document.querySelector(s);
  let container = $('#sidebar-voice-status');
  if (!container) {
    container = document.createElement('div');
    container.id = 'sidebar-voice-status';
    container.className = 'voice-status-bar hidden';
    const userPanel = $('.sidebar-user');
    if (userPanel && userPanel.parentNode) {
      userPanel.parentNode.insertBefore(container, userPanel);
    }
  }

  if (activeVoiceChannelId) {
    let chName = 'Voice Channel';
    const ch = channels.find(c => c.id === activeVoiceChannelId);
    if (ch) chName = ch.name;

    container.innerHTML = `
      <div class="voice-status-info">
        <div class="voice-status-label">
          <div class="signal-icon" id="voice-ping-icon" title="Ping: <50ms">
            <div class="signal-bar active"></div>
            <div class="signal-bar active"></div>
            <div class="signal-bar active"></div>
            <div class="signal-bar active"></div>
          </div>
          Connected
        </div>
        <div class="voice-status-channel">${escapeHtml(chName)}</div>
      </div>
      <button class="btn-icon voice-disconnect-btn" title="Disconnect">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 17l5-5-5-5M19.8 12H9M10 3H4v18h6"/></svg>
      </button>
    `;
    container.classList.remove('hidden');
    container.querySelector('.voice-disconnect-btn').onclick = disconnectVoice;

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      const icon = document.getElementById('voice-ping-icon');
      if (!icon) return;
      const bars = icon.querySelectorAll('.signal-bar');
      const quality = Math.random();
      bars.forEach(b => b.className = 'signal-bar');
      if (quality > 0.85) {
        bars[0].classList.add('poor');
        icon.title = 'Ping: 150ms+ (Poor)';
      } else if (quality > 0.6) {
        bars[0].classList.add('warn');
        bars[1].classList.add('warn');
        icon.title = 'Ping: ~80ms (Fair)';
      } else {
        bars[0].classList.add('active');
        bars[1].classList.add('active');
        bars[2].classList.add('active');
        if (quality < 0.3) bars[3].classList.add('active');
        icon.title = 'Ping: <40ms (Good)';
      }
    }, 3000);
  } else {
    container.classList.add('hidden');
    if (pingInterval) clearInterval(pingInterval);
  }
}
