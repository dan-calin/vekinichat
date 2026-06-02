import { supabase } from './supabase.js';

export async function fetchUserServers(userId) {
    const { data: memberships, error } = await supabase
        .from('server_members')
        .select('server_id, servers ( id, name, icon_url, invite_code, owner_id )')
        .eq('user_id', userId)
        .order('joined_at', { ascending: true });

    if (error) {
        console.error('Failed to load servers:', error);
        throw error;
    }
    return (memberships || []).map((m) => m.servers);
}

export async function fetchServerChannels(serverId) {
    const { data, error } = await supabase
        .from('channels')
        .select('id, name, type, is_private')
        .eq('server_id', serverId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('Failed to load channels:', error);
        throw error;
    }
    return data || [];
}

export async function fetchMemberPermissions(serverId, userId) {
    const { data: memberData } = await supabase
        .from('server_members')
        .select('id')
        .eq('server_id', serverId)
        .eq('user_id', userId)
        .maybeSingle();

    if (!memberData) return {};

    const { data: rolesData } = await supabase
        .from('server_member_roles')
        .select('role_id')
        .eq('member_id', memberData.id);

    if (!rolesData || rolesData.length === 0) return {};

    const roleIds = rolesData.map(r => r.role_id);
    const { data: permData } = await supabase
        .from('server_roles')
        .select('permissions')
        .in('id', roleIds);

    const mergedPermissions = {};
    if (permData) {
        permData.forEach(r => {
            const p = r.permissions || {};
            if (p.manage_channels) mergedPermissions.manage_channels = true;
            if (p.delete_messages) mergedPermissions.delete_messages = true;
            if (p.kick_members) mergedPermissions.kick_members = true;
            if (p.manage_roles) mergedPermissions.manage_roles = true;
        });
    }
    return mergedPermissions;
}
