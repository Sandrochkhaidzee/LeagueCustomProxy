// supabase/functions/turn-credentials/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const TURN_SERVER = Deno.env.get('TURN_SERVER') || '';
const TURN_SECRET = Deno.env.get('TURN_SECRET') || '';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET',
      },
    });
  }

  if (!TURN_SERVER || !TURN_SECRET) {
    return new Response(JSON.stringify({ iceServers: [] }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Generate time-limited TURN credentials using HMAC-SHA1
  // coturn's use-auth-secret expects: username = "expiry:arbitrary", credential = HMAC-SHA1(secret, username)
  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = expiry + ':proxchat';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: `stun:${TURN_SERVER}:3478` },
    { urls: `turn:${TURN_SERVER}:3478`, username, credential },
    { urls: `turns:${TURN_SERVER}:5349`, username, credential },
  ];

  return new Response(JSON.stringify({ iceServers }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
