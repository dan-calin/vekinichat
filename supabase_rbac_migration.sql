-- Supabase DB Migration: Server RBAC and Private Channels
-- Run this in your Supabase SQL Editor

-- 1. Create server_roles table
CREATE TABLE IF NOT EXISTS public.server_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#99AAB5',
    permissions JSONB DEFAULT '{"manage_channels": false, "kick_members": false, "delete_messages": false, "manage_roles": false}'::jsonb,
    position_num INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for roles
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Roles viewable by server members" ON public.server_roles
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm 
            WHERE sm.server_id = server_roles.server_id AND sm.user_id = auth.uid()
        )
    );

-- 2. Create server_member_roles junction table
CREATE TABLE IF NOT EXISTS public.server_member_roles (
    member_id UUID NOT NULL REFERENCES public.server_members(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES public.server_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (member_id, role_id)
);

-- Enable RLS for member roles
ALTER TABLE public.server_member_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Member roles viewable by server members" ON public.server_member_roles
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.server_roles sr ON sr.id = server_member_roles.role_id
            WHERE sm.server_id = sr.server_id AND sm.user_id = auth.uid()
        )
    );

-- 3. Modify channels for private channels
ALTER TABLE public.channels 
ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS allowed_roles UUID[] DEFAULT NULL;

-- 4. Helper Function: Check Permissions
-- This securely checks if a user has a specific permission via their roles, or if they are the owner.
CREATE OR REPLACE FUNCTION public.has_server_permission(p_server_id UUID, p_user_id UUID, p_permission_flag TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT 
        -- Are they the owner?
        EXISTS (
            SELECT 1 FROM public.servers WHERE id = p_server_id AND owner_id = p_user_id
        )
        OR
        -- Do they have a role with the permission set to true?
        EXISTS (
            SELECT 1 
            FROM public.server_members sm
            JOIN public.server_member_roles smr ON smr.member_id = sm.id
            JOIN public.server_roles sr ON sr.id = smr.role_id
            WHERE sm.server_id = p_server_id 
              AND sm.user_id = p_user_id
              AND (sr.permissions->>p_permission_flag)::boolean = true
        )
$$;

-- 5. Secure Function: Delete Message as Admin
CREATE OR REPLACE FUNCTION public.delete_message_as_admin(p_message_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_has_permission BOOLEAN;
BEGIN
    -- Get the server_id where this message was posted
    SELECT c.server_id INTO v_server_id
    FROM public.messages m
    JOIN public.channels c ON c.id = m.channel_id
    WHERE m.id = p_message_id;

    IF v_server_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Check if caller has 'delete_messages' permission
    v_has_permission := public.has_server_permission(v_server_id, auth.uid(), 'delete_messages');

    IF NOT v_has_permission THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;

    -- Delete the message
    DELETE FROM public.messages WHERE id = p_message_id;
    RETURN TRUE;
END;
$$;

-- 6. Secure Function: Kick Member
CREATE OR REPLACE FUNCTION public.kick_member(p_server_id UUID, p_user_id_to_kick UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_has_permission BOOLEAN;
    v_is_owner BOOLEAN;
BEGIN
    -- Cannot kick the owner
    SELECT EXISTS(SELECT 1 FROM public.servers WHERE id = p_server_id AND owner_id = p_user_id_to_kick) INTO v_is_owner;
    IF v_is_owner THEN
        RAISE EXCEPTION 'Cannot kick the server owner';
    END IF;

    -- Check if caller has 'kick_members' permission
    v_has_permission := public.has_server_permission(p_server_id, auth.uid(), 'kick_members');

    IF NOT v_has_permission THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;

    -- Delete the member
    DELETE FROM public.server_members WHERE server_id = p_server_id AND user_id = p_user_id_to_kick;
    RETURN TRUE;
END;
$$;

-- 7. Update Policies (Safe)
-- Ensure 'channels' policy respects 'is_private' and 'allowed_roles' constraints
DROP POLICY IF EXISTS "Server members view channels" ON public.channels;
CREATE POLICY "Server members view channels" ON public.channels
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm WHERE sm.server_id = channels.server_id AND sm.user_id = auth.uid()
        )
        AND (
            NOT is_private
            OR EXISTS (
                SELECT 1 FROM public.servers WHERE id = channels.server_id AND owner_id = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM public.server_members sm
                JOIN public.server_member_roles smr ON smr.member_id = sm.id
                WHERE sm.server_id = channels.server_id 
                  AND sm.user_id = auth.uid()
                  AND smr.role_id = ANY(channels.allowed_roles)
            )
        )
    );

-- Roles assignment/modification policy (must be owner or have manage_roles)
CREATE POLICY "Manage roles" ON public.server_roles
    FOR ALL TO authenticated
    USING (public.has_server_permission(server_id, auth.uid(), 'manage_roles'))
    WITH CHECK (public.has_server_permission(server_id, auth.uid(), 'manage_roles'));

CREATE POLICY "Manage member roles" ON public.server_member_roles
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_roles sr 
            WHERE sr.id = server_member_roles.role_id 
              AND public.has_server_permission(sr.server_id, auth.uid(), 'manage_roles')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.server_roles sr 
            WHERE sr.id = server_member_roles.role_id 
              AND public.has_server_permission(sr.server_id, auth.uid(), 'manage_roles')
        )
    );
