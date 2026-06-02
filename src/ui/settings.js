import { supabase } from '../supabase.js';

let ctx;
let _openServerSettingsModal = null;
let _refreshVoiceSettings = null;

/** Called by sidebar when the user clicks the server gear icon */
export function openServerSettingsModal(srv) {
  if (_openServerSettingsModal) _openServerSettingsModal(srv);
}

/** Called by main.js when the user opens their settings, to (re)load audio devices/prefs */
export function refreshVoiceSettings() {
  if (_refreshVoiceSettings) return _refreshVoiceSettings();
}

export function initSettingsModule(context) {
  ctx = context;
  
  
  const $ = (sel) => document.querySelector(sel);
  const uploadAvatarBtn = $('#upload-avatar-btn');
  const avatarUploadInput = $('#avatar-upload');
  const settingsProfileForm = $('#settings-profile-form');
  const settingsUsernameInput = $('#settings-username');
  const settingNoiseSuppression = $('#setting-noise-suppression');
  const settingEchoCancellation = $('#setting-echo-cancellation');
  const settingAutoGain = $('#setting-auto-gain');
  const inputDeviceSelect = $('#input-device-select');
  const outputDeviceSelect = $('#output-device-select');
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const serverSettingsModalOverlay = $('#server-settings-modal-overlay');
  const renameServerForm = $('#rename-server-form');
  const renameServerInput = $('#rename-server-input');
  const renameServerBtn = $('#rename-server-btn');
  const memberManagementList = $('#member-management-list');
  const serverSettingsIconPreview = $('#server-settings-icon-preview');
  const serverIconUploadInput = $('#server-icon-upload');
  const deleteServerConfirmContainer = $('#delete-server-confirm-container');
  const deleteServerBtn = $('#delete-server-btn');
  const deleteServerConfirmInput = $('#delete-server-confirm-input');
  const deleteServerConfirmBtn = $('#delete-server-confirm-btn');
  const serverSettingsClose = $('#server-settings-close');
  const settingsModal = $('#settings-modal');
  const renameServerCancelBtn = $('#rename-server-cancel-btn');


  // Domain variables are naturally declared below  

  function renderKeybinds() {
  const container = document.getElementById('keybind-list');
  if (!container) return;

  container.innerHTML = '';
  Object.entries(ctx.keybinds).forEach(([action, chord]) => {
    const item = document.createElement('div');
    item.className = 'keybind-item';
    item.innerHTML = `
      <span>${formatActionName(action)}</span>
      <button class="btn-keybind" data-action="${action}">${formatChord(chord)}</button>
    `;

    const btn = item.querySelector('.btn-keybind');
    btn.addEventListener('click', () => startRecordingKeybind(btn, action));

    container.appendChild(item);
  });
}

function formatActionName(action) {
  return action.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function formatChord(chord) {
  if (!chord) return 'Unbound';
  return chord
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .replace(/\+/g, ' + ');
}

function startRecordingKeybind(btn, action) {
  btn.textContent = 'Press keys…';
  btn.classList.add('recording');

  // Cancel any previously recording buttons
  document.querySelectorAll('.btn-keybind.recording').forEach(b => {
    if (b !== btn) {
      b.classList.remove('recording');
      b.textContent = formatChord(ctx.keybinds[b.dataset.action]);
    }
  });

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Escape cancels
    if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      btn.textContent = formatChord(ctx.keybinds[action]);
      btn.classList.remove('recording');
      document.removeEventListener('keydown', handler);
      return;
    }

    // Only capture if there's a non-modifier key pressed
    const modifierCodes = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
      'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);
    if (modifierCodes.has(e.code)) return; // wait for a real key

    const chord = ctx.eventToChord(e);

    // Clear this chord from any other action (exclusive binding)
    for (const [otherAction] of Object.entries(ctx.keybinds)) {
      if (otherAction !== action && ctx.keybinds[otherAction] === chord) {
        ctx.keybinds[otherAction] = null;
      }
    }

    ctx.keybinds[action] = chord;
    ctx.saveKeybinds();
    btn.textContent = formatChord(chord);
    btn.classList.remove('recording');
    document.removeEventListener('keydown', handler);

    // Re-render all buttons to update any cleared binds
    renderKeybinds();
  };

  document.addEventListener('keydown', handler);
}


/* ============================================================
   Settings Logic (Updated)
   ============================================================ */

// Avatar Upload
if (uploadAvatarBtn && avatarUploadInput) {
  uploadAvatarBtn.addEventListener('click', () => avatarUploadInput.click());

  avatarUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = (ev) => updateAvatarPreview(ev.target.result);
    reader.readAsDataURL(file);
  });
}

// Profile Save with Upload
if (settingsProfileForm) {
  settingsProfileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newUsername = settingsUsernameInput.value.trim();
    const file = avatarUploadInput?.files[0];

    let newAvatarUrl = ctx.currentProfile.avatar_url;

    try {
      if (file) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${ctx.currentUser.id}-${Date.now()}.${fileExt}`;
        const filePath = `${fileName}`;

        const { error: uploadErr } = await supabase.storage
          .from('avatars')
          .upload(filePath, file);

        if (uploadErr) throw uploadErr;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        newAvatarUrl = publicUrl;
      }

      const { error } = await supabase
        .from('profiles')
        .update({ username: newUsername, avatar_url: newAvatarUrl })
        .eq('id', ctx.currentUser.id);

      if (error) throw error;

      if (!ctx.currentProfile) ctx.currentProfile = {};
      ctx.currentProfile.username = newUsername;
      ctx.currentProfile.avatar_url = newAvatarUrl;

      // Update cache so chat messages reflect the change immediately
      ctx.profileCache.set(ctx.currentUser.id, { ...ctx.currentProfile });

      document.getElementById('user-name').textContent = newUsername;
      const avatarEl = document.getElementById('user-avatar');
      if (newAvatarUrl) {
        avatarEl.style.backgroundImage = `url('${newAvatarUrl}')`;
        avatarEl.textContent = '';
      } else {
        avatarEl.style.backgroundImage = 'none';
        avatarEl.textContent = newUsername.charAt(0).toUpperCase();
      }

      alert('Profile updated successfully!');
      settingsModal.classList.add('hidden');
    } catch (err) {
      console.error('Error updating profile:', err);
      alert('Failed to update profile: ' + err.message);
    }
  });
}

// Voice Settings & Devices
async function loadVoiceSettings() {
  // Load Preferences
  const savedSettings = JSON.parse(localStorage.getItem('vekini_voice_settings')) || {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  };

  if (settingNoiseSuppression) settingNoiseSuppression.checked = savedSettings.noiseSuppression;
  if (settingEchoCancellation) settingEchoCancellation.checked = savedSettings.echoCancellation;
  if (settingAutoGain) settingAutoGain.checked = savedSettings.autoGainControl;

  // Load Devices
  const devices = await ctx.getAudioDevices();

  const populateSelect = (select, items, type) => {
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="default">Default</option>';
    items.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${type} ${select.options.length}`;
      select.appendChild(opt);
    });
    // Restore selection if possible, else default
    if (Object.values(items).some(d => d.deviceId === currentVal)) {
      select.value = currentVal;
    }
  };

  populateSelect(inputDeviceSelect, devices.inputs, 'Microphone');
  populateSelect(outputDeviceSelect, devices.outputs, 'Speaker');

  if (inputDeviceSelect) {
    inputDeviceSelect.onchange = (e) => ctx.setInputDevice(e.target.value);
  }
  if (outputDeviceSelect) {
    outputDeviceSelect.onchange = (e) => ctx.setOutputDevice(e.target.value);
  }

  ctx.updateAudioOptions(savedSettings);
}
// Expose to main.js (which owns the settings-modal open handler)
_refreshVoiceSettings = loadVoiceSettings;

// Render Keybinds when tab is opened
settingsTabs.forEach(tab => {
  if (tab.dataset.tab === 'keybinds') {
    tab.addEventListener('click', renderKeybinds);
  }
});

[settingNoiseSuppression, settingEchoCancellation, settingAutoGain].forEach(input => {
  if (input) {
    input.addEventListener('change', () => {
      const newSettings = {
        noiseSuppression: settingNoiseSuppression.checked,
        echoCancellation: settingEchoCancellation.checked,
        autoGainControl: settingAutoGain.checked,
      };
      localStorage.setItem('vekini_voice_settings', JSON.stringify(newSettings));
      ctx.updateAudioOptions(newSettings);
    });
  }
});

loadVoiceSettings();

/* ============================================================
   Server Settings Logic
   ============================================================ */
let activeSettingsServer = null;

// defineOpenServerSettingsModal is called at end of initSettingsModule
// so that DOM variable bindings are available in the closure.

// Handle Server Settings Tab Switching
const serverSettingsTabs = document.querySelectorAll('#server-settings-modal-overlay .settings-tab:not(.danger)');
const serverSettingsPanes = document.querySelectorAll('#server-settings-modal-overlay .settings-pane');

serverSettingsTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    // Deactivate all
    serverSettingsTabs.forEach(t => t.classList.remove('active'));
    serverSettingsPanes.forEach(p => p.classList.remove('active'));

    // Activate clicked
    tab.classList.add('active');
    const paneId = `pane-${tab.dataset.tab}`;
    const targetPane = document.getElementById(paneId);
    if (targetPane) targetPane.classList.add('active');

    if (tab.dataset.tab === 'roles') {
      loadServerRoles(activeSettingsServer.id);
    } else if (tab.dataset.tab === 'members') {
      loadServerMembersForSettings(activeSettingsServer);
    }
  });
});

async function loadServerMembersForSettings(srv) {
  memberManagementList.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">Loading members...</div>';

  // Always ensure serverRolesCache matches the current settings server
  if (serverRolesCache.length === 0 || (serverRolesCache[0] && serverRolesCache[0].server_id !== srv.id)) {
    const { data: rolesData } = await supabase
      .from('server_roles')
      .select('*')
      .eq('server_id', srv.id)
      .order('position_num', { ascending: false });
    serverRolesCache = rolesData || [];
  }

  const { data: membersData, error } = await supabase
    .from('server_members')
    .select('id, user_id, profiles(username, avatar_url)')
    .eq('server_id', srv.id);

  if (error) {
    memberManagementList.innerHTML = `<div style="padding: 10px; color: var(--danger);">Error loading members</div>`;
    console.error('Failed to load server members:', error);
    return;
  }

  // Fetch roles separately to avoid schema relationship cache issues
  const memberIds = membersData.map(m => m.id);
  let rolesRelationData = [];
  if (memberIds.length > 0) {
    const { data } = await supabase
      .from('server_member_roles')
      .select('member_id, role_id')
      .in('member_id', memberIds);
    if (data) rolesRelationData = data;
  }

  const data = membersData.map(mem => {
    const memRoles = rolesRelationData
      ? rolesRelationData.filter(r => r.member_id === mem.id)
      : [];
    return { ...mem, server_member_roles: memRoles };
  });

  memberManagementList.innerHTML = '';
  if (!data || data.length === 0) {
    memberManagementList.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">No members found.</div>';
    return;
  }

  data.forEach((mem) => {
    const prof = mem.profiles;
    if (!prof) return;

    const isOwnerBadge = (mem.user_id === srv.owner_id);

    const item = document.createElement('div');
    item.className = 'member-management-item';

    let avatarHtml = `<div class="user-avatar" style="width: 32px; height: 32px; font-size: 14px;">${(prof.username || '?').charAt(0).toUpperCase()}</div>`;
    if (prof.avatar_url) {
      avatarHtml = `<div class="user-avatar" style="width: 32px; height: 32px; background-image: url('${escapeHtml(prof.avatar_url)}'); background-size: cover; background-position: center; border-radius: 50%;"></div>`;
    }

    // Role Badges
    const userRoleIds = mem.server_member_roles?.map(rm => rm.role_id) || [];
    let badgesHtml = '';

    userRoleIds.forEach(rId => {
      const roleDef = serverRolesCache.find(r => r.id === rId);
      if (roleDef) {
        badgesHtml += `<div class="role-badge" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid ${escapeHtml(roleDef.color)}; font-size: 0.65rem; color: ${escapeHtml(roleDef.color)}; margin-right: 4px; margin-top: 4px;">
          <div style="width: 6px; height: 6px; border-radius: 50%; background: ${escapeHtml(roleDef.color)};"></div>
          ${escapeHtml(roleDef.name)}
        </div>`;
      }
    });

    let assignRoleBtnHtml = '';
    // Let Owner (or anyone with manage_roles on the active server) assign roles
    const canManageRoles = (srv.owner_id === ctx.currentUser.id) || (ctx.activeServerId === srv.id && ctx.hasPermission('manage_roles'));
    if (canManageRoles) {
      assignRoleBtnHtml = `<button class="btn-icon" title="Add Role" style="width: 20px; height: 20px; padding: 0; font-size: 14px; margin-top: 4px;" onclick="openRoleAssignMenu(event, '${mem.id}', '${mem.user_id}', ${JSON.stringify(userRoleIds).replace(/"/g, '&quot;')})">+</button>`;
    }

    item.innerHTML = `
      <div class="member-info" style="align-items: flex-start;">
        ${avatarHtml}
        <div style="display: flex; flex-direction: column;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 500; font-size: 0.95rem;">${escapeHtml(prof.username || 'Unknown')}</span>
            ${isOwnerBadge ? '<span style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600; text-transform: uppercase;">Owner</span>' : ''}
          </div>
          <div style="display: flex; flex-wrap: wrap; align-items: center;">
            ${badgesHtml}
            ${assignRoleBtnHtml}
          </div>
        </div>
      </div>
    `;

    const canKick = (srv.owner_id === ctx.currentUser.id) || (ctx.activeServerId === srv.id && ctx.hasPermission('kick_members'));
    if (!isOwnerBadge && canKick) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn btn-secondary';
      kickBtn.style.padding = '4px 12px';
      kickBtn.style.fontSize = '0.75rem';
      kickBtn.style.border = '1px solid rgba(239, 68, 68, 0.5)';
      kickBtn.style.color = 'var(--danger)';
      kickBtn.style.width = 'auto'; // Prevent full width stretch from .btn
      kickBtn.style.flex = '0 0 auto'; // Prevent flex growing
      kickBtn.textContent = 'Kick';
      kickBtn.onclick = () => confirmKick(mem.user_id, prof.username, item);
      item.appendChild(kickBtn);
    }

    memberManagementList.appendChild(item);
  });
}

function openRoleAssignMenu(e, memberId, userId, currentUserRoleIds) {
  // Remove existing menu if any
  const existing = document.getElementById('role-assign-popover');
  if (existing) existing.remove();

  if (serverRolesCache.length === 0) {
    alert("No roles available in this server.");
    return;
  }

  const popover = document.createElement('div');
  popover.id = 'role-assign-popover';
  popover.style.cssText = `
    position: absolute;
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    padding: 8px;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    min-width: 150px;
  `;

  serverRolesCache.forEach(role => {
    const hasRole = currentUserRoleIds.includes(role.id);

    const row = document.createElement('label');
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      color: var(--text-secondary);
    `;
    row.onmouseenter = () => row.style.background = 'rgba(255,255,255,0.05)';
    row.onmouseleave = () => row.style.background = 'transparent';

    row.innerHTML = `
      <input type="checkbox" ${hasRole ? 'checked' : ''} style="margin: 0;">
      <div style="width: 10px; height: 10px; border-radius: 50%; background: ${escapeHtml(role.color)};"></div>
      ${escapeHtml(role.name)}
    `;

    row.querySelector('input').addEventListener('change', async (ev) => {
      const adding = ev.target.checked;
      row.style.pointerEvents = 'none';
      row.style.opacity = '0.5';

      if (adding) {
        const { error } = await supabase.from('server_member_roles').insert({
          member_id: memberId,
          role_id: role.id
        });
        if (error) {
          console.error("Assign role error:", error);
          ev.target.checked = false;
        }
      } else {
        const { error } = await supabase.from('server_member_roles').delete()
          .eq('member_id', memberId)
          .eq('role_id', role.id);
        if (error) {
          console.error("Remove role error:", error);
          ev.target.checked = true;
        }
      }

      row.style.pointerEvents = 'auto';
      row.style.opacity = '1';

      if (userId === ctx.currentUser.id) {
        await ctx.loadCurrentUserPermissions(activeSettingsServer.id, activeSettingsServer.owner_id);
        ctx.renderSidebar();
      }

      // Refresh members list silently to upadte badges
      loadServerMembersForSettings(activeSettingsServer);
    });

    popover.appendChild(row);
  });

  document.body.appendChild(popover);

  // Position it
  const rect = e.target.getBoundingClientRect();
  popover.style.top = (rect.bottom + 4) + 'px';
  popover.style.left = rect.left + 'px';

  // Click outside listener
  const closeListener = (ev) => {
    if (!popover.contains(ev.target) && ev.target !== e.target) {
      popover.remove();
      document.removeEventListener('click', closeListener);
    }
  };
  setTimeout(() => document.addEventListener('click', closeListener), 10);
}
window.openRoleAssignMenu = openRoleAssignMenu;

// Global state for roles
let serverRolesCache = [];
let activeEditedRole = null;

async function loadServerRoles(serverId) {
  const container = document.getElementById('roles-list-container');
  const editor = document.getElementById('role-editor-container');
  const emptyState = document.getElementById('role-editor-empty');

  container.innerHTML = '<div style="color: var(--text-muted); padding: 8px;">Loading roles...</div>';
  editor.style.display = 'none';
  emptyState.style.display = 'flex';
  activeEditedRole = null;

  const { data, error } = await supabase
    .from('server_roles')
    .select('*')
    .eq('server_id', serverId)
    .order('position_num', { ascending: false });

  if (error) {
    console.error('Error fetching roles:', error);
    container.innerHTML = `<div style="color: var(--danger); padding: 8px;">Failed to load roles</div>`;
    return;
  }

  serverRolesCache = data || [];
  renderRolesList();
}

function renderRolesList() {
  const container = document.getElementById('roles-list-container');
  container.innerHTML = '';

  if (serverRolesCache.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px;">No roles. Click + to create one.</div>';
    return;
  }

  serverRolesCache.forEach(role => {
    const el = document.createElement('div');
    el.style.cssText = `
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
      background: ${activeEditedRole?.id === role.id ? 'rgba(255,255,255,0.1)' : 'transparent'};
      color: ${activeEditedRole?.id === role.id ? '#fff' : 'var(--text-secondary)'};
    `;

    // Add hover effect programmatically to simplify CSS requirements
    el.onmouseenter = () => { if (activeEditedRole?.id !== role.id) el.style.background = 'rgba(255,255,255,0.05)'; };
    el.onmouseleave = () => { if (activeEditedRole?.id !== role.id) el.style.background = 'transparent'; };

    el.innerHTML = `
      <div style="width: 12px; height: 12px; border-radius: 50%; background-color: ${escapeHtml(role.color)};"></div>
      <span style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(role.name)}</span>
    `;

    el.onclick = () => openRoleEditor(role);
    container.appendChild(el);
  });
}

function openRoleEditor(role) {
  activeEditedRole = role;
  renderRolesList(); // re-render to update active styling

  document.getElementById('role-editor-empty').style.display = 'none';
  const editor = document.getElementById('role-editor-container');
  editor.style.display = 'flex';

  document.getElementById('role-edit-name').value = role.name;
  document.getElementById('role-edit-color').value = role.color;

  const perms = role.permissions || {};
  document.getElementById('role-perm-manage-channels').checked = !!perms.manage_channels;
  document.getElementById('role-perm-kick-members').checked = !!perms.kick_members;
  document.getElementById('role-perm-delete-messages').checked = !!perms.delete_messages;
  document.getElementById('role-perm-manage-roles').checked = !!perms.manage_roles;
}

// Role Actions
const createRoleBtn = document.getElementById('create-role-btn');
const saveRoleBtn = document.getElementById('save-role-btn');
const deleteRoleBtn = document.getElementById('delete-role-btn');

if (createRoleBtn) {
  createRoleBtn.addEventListener('click', async () => {
    if (!activeSettingsServer) return;

    // Auto-generate a new role
    const newRole = {
      server_id: activeSettingsServer.id,
      name: 'New Role',
      color: '#99AAB5',
      permissions: {
        manage_channels: false,
        kick_members: false,
        delete_messages: false,
        manage_roles: false
      },
      position_num: serverRolesCache.length + 1
    };

    createRoleBtn.disabled = true;
    const { data, error } = await supabase
      .from('server_roles')
      .insert(newRole)
      .select()
      .single();
    createRoleBtn.disabled = false;

    if (error) {
      alert('Failed to create role: ' + error.message);
      return;
    }

    serverRolesCache.unshift(data); // Add to top for visibility
    openRoleEditor(data);
  });
}

if (saveRoleBtn) {
  saveRoleBtn.addEventListener('click', async () => {
    if (!activeEditedRole) return;

    const newName = document.getElementById('role-edit-name').value.trim() || 'Unnamed Role';
    const newColor = document.getElementById('role-edit-color').value;
    const permissions = {
      manage_channels: document.getElementById('role-perm-manage-channels').checked,
      kick_members: document.getElementById('role-perm-kick-members').checked,
      delete_messages: document.getElementById('role-perm-delete-messages').checked,
      manage_roles: document.getElementById('role-perm-manage-roles').checked,
    };

    saveRoleBtn.disabled = true;
    const { error } = await supabase
      .from('server_roles')
      .update({ name: newName, color: newColor, permissions })
      .eq('id', activeEditedRole.id);
    saveRoleBtn.disabled = false;

    if (error) {
      alert('Failed to save role: ' + error.message);
      return;
    }

    activeEditedRole.name = newName;
    activeEditedRole.color = newColor;
    activeEditedRole.permissions = permissions;
    renderRolesList();
  });
}

if (deleteRoleBtn) {
  deleteRoleBtn.addEventListener('click', async () => {
    if (!activeEditedRole) return;
    if (!confirm(`Are you sure you want to delete the role "${activeEditedRole.name}"?`)) return;

    deleteRoleBtn.disabled = true;
    const { error } = await supabase
      .from('server_roles')
      .delete()
      .eq('id', activeEditedRole.id);
    deleteRoleBtn.disabled = false;

    if (error) {
      alert('Failed to delete role: ' + error.message);
      return;
    }

    serverRolesCache = serverRolesCache.filter(r => r.id !== activeEditedRole.id);
    document.getElementById('role-editor-empty').style.display = 'flex';
    document.getElementById('role-editor-container').style.display = 'none';
    activeEditedRole = null;
    renderRolesList();
  });
}

async function confirmKick(userId, username, itemElement) {
  if (!confirm(`Are you sure you want to kick ${username}?`)) return;

  const { error } = await supabase.rpc('kick_member', {
    p_server_id: activeSettingsServer.id,
    p_user_id_to_kick: userId
  });

  if (error) {
    alert('Failed to kick user: ' + error.message);
  } else {
    itemElement.remove();
  }
}
window.confirmKick = confirmKick;

// Rename Server
if (renameServerForm) {
  renameServerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeSettingsServer) return;

    const newName = renameServerInput.value.trim();
    if (!newName) return;

    renameServerBtn.disabled = true;
    renameServerBtn.textContent = '...';

    const { error } = await supabase
      .from('servers')
      .update({ name: newName })
      .eq('id', activeSettingsServer.id);

    renameServerBtn.disabled = false;
    renameServerBtn.textContent = 'Save';

    if (error) {
      alert('Failed to rename server: ' + error.message);
    } else {
      activeSettingsServer.name = newName;
      // Realtime stream might take a second, update local immediately
      const serverHeaderEl = document.querySelector(`.server-accordion[data-server-id="${activeSettingsServer.id}"] .server-name`);
      if (serverHeaderEl) serverHeaderEl.textContent = newName;

      const serverIconEl = document.querySelector(`.server-accordion[data-server-id="${activeSettingsServer.id}"] .server-icon`);
      if (serverIconEl) serverIconEl.textContent = newName.charAt(0).toUpperCase();

      if (ctx.activeServerId === activeSettingsServer.id) {
        const welcomeState = document.querySelector('#main-content .empty-state h2');
        if (welcomeState && welcomeState.textContent.startsWith('Welcome to ')) welcomeState.textContent = 'Welcome to ' + newName;
      }
    }
  });
}

// Delete Server Initial Click
if (deleteServerBtn) {
  deleteServerBtn.addEventListener('click', () => {
    if (!activeSettingsServer) return;

    // Show confirmation UI
    deleteServerConfirmContainer.classList.remove('hidden');
    deleteServerConfirmInput.value = '';
    deleteServerConfirmInput.placeholder = activeSettingsServer.name;
    deleteServerConfirmInput.focus();
    deleteServerBtn.style.display = 'none';
  });
}

// Confirm Delete Click
if (deleteServerConfirmBtn) {
  deleteServerConfirmBtn.addEventListener('click', async () => {
    if (!activeSettingsServer) return;

    const confirmName = deleteServerConfirmInput.value.trim();
    if (confirmName !== activeSettingsServer.name) {
      alert("Server name did not match. Deletion aborted.");
      deleteServerConfirmContainer.classList.add('hidden');
      deleteServerBtn.style.display = 'block';
      return;
    }

    const { error } = await supabase
      .from('servers')
      .delete()
      .eq('id', activeSettingsServer.id);

    if (error) {
      alert('Failed to delete server: ' + error.message);
      deleteServerConfirmContainer.classList.add('hidden');
      deleteServerBtn.style.display = 'block';
    } else {
      serverSettingsModalOverlay.classList.add('hidden');
      const delId = activeSettingsServer.id;
      activeSettingsServer = null;
      if (ctx.activeServerId === delId) {
        ctx.activeServerId = null;
      }
      ctx.loadServers(); // Trigger a full reload of ctx.servers
    }
  });
}

// Server Icon Upload Pipeline
if (serverSettingsIconPreview && serverIconUploadInput) {
  serverSettingsIconPreview.addEventListener('click', () => {
    serverIconUploadInput.click();
  });

  serverIconUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !activeSettingsServer) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file.');
      return;
    }

    // Temporary optimistic UI
    const originalStyle = serverSettingsIconPreview.getAttribute('style');
    const originalText = serverSettingsIconPreview.textContent;
    serverSettingsIconPreview.style.filter = 'brightness(50%) blur(2px)';

    try {
      const ext = file.name.split('.').pop();
      const fileName = `${activeSettingsServer.id}_${Date.now()}.${ext}`;
      const filePath = `server_icons/${fileName}`;

      // 1. Upload to existing `avatars` bucket
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // 2. Get Public URL
      const { data: publicUrlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      const publicUrl = publicUrlData.publicUrl;

      // 3. Update ctx.servers table
      const { error: updateError } = await supabase
        .from('servers')
        .update({ icon_url: publicUrl })
        .eq('id', activeSettingsServer.id);

      if (updateError) throw updateError;

      // 4. Update local state and UI
      activeSettingsServer.icon_url = publicUrl;
      const cachedSrv = ctx.servers.find(s => s.id === activeSettingsServer.id);
      if (cachedSrv) cachedSrv.icon_url = publicUrl;

      // Render the new icon in the settings modal preview immediately
      serverSettingsIconPreview.style.filter = '';
      serverSettingsIconPreview.style.backgroundImage = `url('${escapeHtml(publicUrl)}')`;
      serverSettingsIconPreview.style.backgroundSize = 'cover';
      serverSettingsIconPreview.style.backgroundPosition = 'center';
      serverSettingsIconPreview.style.border = 'none';
      serverSettingsIconPreview.style.color = 'transparent';
      serverSettingsIconPreview.textContent = '';

      // Re-render sidebar to reflect icon change globally
      ctx.renderSidebar();

    } catch (err) {
      console.error('Server icon upload failed:', err);
      alert('Failed to upload server icon.');
      serverSettingsIconPreview.setAttribute('style', originalStyle || '');
      serverSettingsIconPreview.textContent = originalText;
    } finally {
      // Clear input so selecting the same file again triggers 'change' event
      serverIconUploadInput.value = '';
    }
  });
}

// Close Modal
if (serverSettingsClose) {
  serverSettingsClose.addEventListener('click', () => {
    serverSettingsModalOverlay.classList.add('hidden');
    activeSettingsServer = null;

    if (deleteServerConfirmContainer) {
      deleteServerConfirmContainer.classList.add('hidden');
      deleteServerBtn.style.display = 'block';
      deleteServerConfirmInput.value = '';
    }
  });
}

  // Expose inner function to the module-level shim
  async function openServerSettingsModal(srv) {
    activeSettingsServer = srv;
    renameServerInput.value = srv.name;
    memberManagementList.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">Loading members...</div>';

    // Set Icon Preview
    const escapeHtml = ctx.escapeHtml;
    if (srv.icon_url) {
      serverSettingsIconPreview.style.backgroundImage = `url('${escapeHtml(srv.icon_url)}')`;
      serverSettingsIconPreview.style.backgroundSize = 'cover';
      serverSettingsIconPreview.style.backgroundPosition = 'center';
      serverSettingsIconPreview.style.border = 'none';
      serverSettingsIconPreview.style.color = 'transparent';
      serverSettingsIconPreview.textContent = '';
    } else {
      serverSettingsIconPreview.style.backgroundImage = '';
      serverSettingsIconPreview.style.border = '';
      serverSettingsIconPreview.style.color = '';
      serverSettingsIconPreview.textContent = srv.name.charAt(0).toUpperCase();
    }

    // Reset delete state
    if (deleteServerConfirmContainer) {
      deleteServerConfirmContainer.classList.add('hidden');
      deleteServerBtn.style.display = 'block';
      deleteServerConfirmInput.value = '';
    }

    // Reset to Overview Tab
    const serverTabs = serverSettingsModalOverlay.querySelectorAll('.settings-tab:not(.danger)');
    const serverPanes = serverSettingsModalOverlay.querySelectorAll('.settings-pane');
    serverTabs.forEach(t => t.classList.remove('active'));
    serverPanes.forEach(p => p.classList.remove('active'));

    const overviewTab = Array.from(serverTabs).find(t => t.dataset.tab === 'overview');
    if (overviewTab) overviewTab.classList.add('active');
    const overviewPane = document.getElementById('pane-overview');
    if (overviewPane) overviewPane.classList.add('active');

    serverSettingsModalOverlay.classList.remove('hidden');

    // Load members initially since Overview/Members share it conceptually
    await loadServerMembersForSettings(srv);
  }

  _openServerSettingsModal = openServerSettingsModal;
}
