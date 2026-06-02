/**
 * voice.js — LiveKit voice channel integration
 * Handles joining/leaving rooms, mute, and speaking detection.
 */
import {
    Room,
    RoomEvent,
    ConnectionState,
    Track,
} from 'livekit-client';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

// ── State ──────────────────────────────────────────────────────────────────
let activeRoom = null;
let onParticipantsChanged = null; // callback(participants[])
let onConnectionStateChanged = null; // callback(state)
let onTrackSubscribed = null; // callback(track, publication, participant)
let onTrackUnsubscribed = null; // callback(track, publication, participant)

// Persistent "intended" mute state — applies even before joining a call and is
// restored on the next join (Discord-style global mute toggle).
let desiredMuted = (() => {
    try { return localStorage.getItem('vekini_muted') === '1'; } catch (e) { return false; }
})();

function persistMuted() {
    try { localStorage.setItem('vekini_muted', desiredMuted ? '1' : '0'); } catch (e) { /* ignore */ }
}

// Default audio options
let audioOptions = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};

export function updateAudioOptions(opts) {
    audioOptions = { ...audioOptions, ...opts };
}

// ── Token fetch ────────────────────────────────────────────────────────────
async function fetchToken(channelId, channelName) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const res = await fetch(
        `${SUPABASE_URL}/functions/v1/livekit-token`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
                apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ channelId, channelName }),
        }
    );

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Token fetch failed: ${res.status}`);
    }

    return res.json(); // { token, wsUrl, roomName }
}

// ── Participant snapshot ───────────────────────────────────────────────────
function buildParticipantList(room) {
    const list = [];

    // Local participant
    const local = room.localParticipant;
    list.push({
        identity: local.identity,
        name: local.name || local.identity,
        isLocal: true,
        isMuted: !local.isMicrophoneEnabled,
        isSpeaking: local.isSpeaking,
        audioLevel: local.audioLevel,
        isScreenShareEnabled: local.isScreenShareEnabled
    });

    // Remote participants
    room.remoteParticipants.forEach((p) => {
        list.push({
            identity: p.identity,
            name: p.name || p.identity,
            isLocal: false,
            isMuted: !p.isMicrophoneEnabled,
            isSpeaking: p.isSpeaking,
            audioLevel: p.audioLevel,
            isScreenShareEnabled: p.isScreenShareEnabled
        });
    });

    return list;
}

export function notifyParticipants() {
    if (activeRoom && onParticipantsChanged) {
        onParticipantsChanged(buildParticipantList(activeRoom));
    }
}

// ── Join ───────────────────────────────────────────────────────────────────
export async function joinVoiceChannel(channelId, channelName, callbacks = {}) {
    // Check for secure context (HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
            'Microphone access is blocked. Browsers require HTTPS for voice chat (except on localhost). ' +
            'If testing on a LAN/VPN, use a secure tunnel (ngrok) or enable "Insecure origins treated as secure" in chrome://flags.'
        );
    }

    // Leave any existing room first
    await leaveVoiceChannel();

    onParticipantsChanged = callbacks.onParticipantsChanged || null;
    onConnectionStateChanged = callbacks.onConnectionStateChanged || null;
    onTrackSubscribed = callbacks.onTrackSubscribed || null;
    onTrackUnsubscribed = callbacks.onTrackUnsubscribed || null;

    console.log('[Voice] Fetching token for:', channelId);
    try {
        const { token, wsUrl } = await fetchToken(channelId, channelName);
        console.log('[Voice] Token received. WS URL:', wsUrl);

        const room = new Room({
            adaptiveStream: true,
            dynacast: true,
            publishDefaults: {
                // Disable simulcast for screen share to prevent WebRTC from sending a low-res layer
                screenShareSimulcast: false,
                screenShareEncoding: {
                    maxBitrate: 5_000_000, // 5 Mbps max
                }
            },
            videoCaptureDefaults: {
                resolution: { width: 1280, height: 720 },
            },
            audioCaptureDefaults: {
                echoCancellation: audioOptions.echoCancellation,
                noiseSuppression: audioOptions.noiseSuppression,
                autoGainControl: audioOptions.autoGainControl,
            },
        });

        activeRoom = room;

        // ── Room events ──────────────────────────────────────────────────────────
        room
            .on(RoomEvent.ParticipantConnected, notifyParticipants)
            .on(RoomEvent.ParticipantDisconnected, notifyParticipants)
            .on(RoomEvent.LocalTrackPublished, notifyParticipants)
            .on(RoomEvent.LocalTrackUnpublished, notifyParticipants)
            .on(RoomEvent.TrackMuted, notifyParticipants)
            .on(RoomEvent.TrackUnmuted, notifyParticipants)
            .on(RoomEvent.ActiveSpeakersChanged, notifyParticipants)
            .on(RoomEvent.ConnectionStateChanged, (state) => {
                console.log('[Voice] Connection state:', state);
                if (onConnectionStateChanged) onConnectionStateChanged(state);
            })
            .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
            .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
            .on(RoomEvent.Disconnected, () => {
                console.log('[Voice] Disconnected');
                activeRoom = null;
                notifyParticipants();
                if (onConnectionStateChanged) onConnectionStateChanged(ConnectionState.Disconnected);
            });

        // Connect and publish microphone
        console.log('[Voice] Connecting to room...');
        await room.connect(wsUrl, token);
        console.log('[Voice] Connected!');

        // Try to enable mic — if the user denies permission, we still stay connected
        try {
            console.log('[Voice] Enabling microphone...');
            await room.localParticipant.setMicrophoneEnabled(!desiredMuted);
            console.log(`[Voice] Microphone ${desiredMuted ? 'left muted' : 'enabled'}.`);
        } catch (micErr) {
            console.warn('[Voice] Microphone permission denied. You are connected but muted.', micErr);
        }

        notifyParticipants();
        return room;
    } catch (err) {
        console.error('[Voice] Error in joinVoiceChannel:', err);
        throw err;
    }
}

function handleTrackSubscribed(track, publication, participant) {
    if (track.kind === 'audio') {
        const element = track.attach();
        document.body.appendChild(element);
    }
    if (onTrackSubscribed) {
        onTrackSubscribed(track, publication, participant);
    }
}

function handleTrackUnsubscribed(track, publication, participant) {
    track.detach().forEach((element) => element.remove());
    if (onTrackUnsubscribed) {
        onTrackUnsubscribed(track, publication, participant);
    }
}

// ── Leave ──────────────────────────────────────────────────────────────────
export async function leaveVoiceChannel() {
    if (activeRoom) {
        await activeRoom.disconnect();
        activeRoom = null;
    }
    onParticipantsChanged = null;
    onConnectionStateChanged = null;
}

// ── Mute toggle ────────────────────────────────────────────────────────────
export async function toggleMute() {
    // Flip the persistent intent so the button works even before joining a call.
    desiredMuted = !desiredMuted;
    persistMuted();
    if (activeRoom && activeRoom.localParticipant) {
        await activeRoom.localParticipant.setMicrophoneEnabled(!desiredMuted);
        notifyParticipants();
    }
    return desiredMuted; // true if now muted
}

// ── Screen Share ───────────────────────────────────────────────────────────
export async function toggleScreenShare(enable, options = {}) {
    if (!activeRoom) throw new Error("No active room");

    if (enable) {
        const fps = options.fps || 30;
        const width = 1920;
        const height = 1080;

        await activeRoom.localParticipant.setScreenShareEnabled(true, {
            audio: true,
            resolution: { width, height }, // Max 1080p
            frameRate: fps,
            // Optimization: Hardware Encoding/Quality
            contentHint: 'detail', // Prioritize crisp details over high FPS
            videoCodec: 'vp9', // VP9 often has better compression/quality at 1080p, falls back to h264/vp8
            // Some versions of LiveKit JS support simulcast options in screen share
            simulcast: false, // For desktop streaming, disabling simulcast can force max bitrates to a single high-quality layer
        });
    } else {
        await activeRoom.localParticipant.setScreenShareEnabled(false);
    }
}
export async function getAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return { inputs: [], outputs: [] };
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
        inputs: devices.filter(d => d.kind === 'audioinput'),
        outputs: devices.filter(d => d.kind === 'audiooutput'),
    };
}

export async function setInputDevice(deviceId) {
    if (activeRoom) {
        await activeRoom.switchActiveDevice('audioinput', deviceId);
    }
    // Persist preference? handled by caller or browser
}

export async function setOutputDevice(deviceId) {
    if (activeRoom) {
        await activeRoom.switchActiveDevice('audiooutput', deviceId);
    }
}

// ── Deafen ─────────────────────────────────────────────────────────────────
let isDeafened = false;

export function setDeafen(enabled) {
    isDeafened = enabled;
    // Mute all remote audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(el => {
        // Only mute remote tracks, not UI sounds if we had any
        // For now, all <audio> are remote tracks
        el.muted = enabled;
    });
    return isDeafened;
}

export function getIsDeafened() {
    return isDeafened;
}

// ── Mic Sensitivity (Gain) ─────────────────────────────────────────────────
// Note: Web Audio gain requires a processor node or track constraints
// LiveKit's Room options handle some processing.
// For now, we will re-apply constraints if needed, but 'sensitivity' usually means
// a noise gate threshold. Web Audio doesn't have a simple standard noise gate.
// We'll expose setting the 'autoGainControl' constraint as a proxy for now.

export async function setMicProcessing(options) {
    updateAudioOptions(options);
    if (activeRoom && activeRoom.localParticipant) {
        // Restart track to apply new constraints? 
        // LiveKit recommends republishing or restarting the track.
        // For simplicity, we just update the config for *next* join, 
        // or try to apply constraints if supported.
        const track = activeRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
        if (track && track.audioTrack && track.audioTrack.mediaStreamTrack) {
            await track.audioTrack.mediaStreamTrack.applyConstraints({
                echoCancellation: options.echoCancellation,
                noiseSuppression: options.noiseSuppression,
                autoGainControl: options.autoGainControl,
            });
        }
    }
}

// ── Getters ────────────────────────────────────────────────────────────────
export function getActiveRoom() { return activeRoom; }
export function isMuted() {
    return desiredMuted;
}

export function setParticipantVolume(identity, volume) {
    if (!activeRoom) return;
    const participant = Array.from(activeRoom.remoteParticipants.values())
        .find(p => p.identity === identity);

    if (participant) {
        participant.getTrackPublications().forEach(pub => {
            if (pub.kind === 'audio' && pub.track) {
                pub.track.setVolume(volume);
            }
        });
    }
}

export function setVoiceCallbacks(callbacks) {
    onParticipantsChanged = callbacks.onParticipantsChanged || null;
    onConnectionStateChanged = callbacks.onConnectionStateChanged || null;
    notifyParticipants();
    if (activeRoom && onConnectionStateChanged) {
        onConnectionStateChanged(activeRoom.state);
    }
}
